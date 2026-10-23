import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";

import { MAX_FILE_BYTES, uploadChatFile } from "../data/files";
import {
  type Channel,
  type ChatFile,
  type Message,
  type Profile,
  deleteMessage,
  editMessage,
  sendMessage,
  watchMessages,
} from "../data/store";
import { initials } from "./Shell";

// Messages from the same person within this gap share one header.
const GROUP_MS = 5 * 60_000;
const URL_RE = /(https?:\/\/[^\s<]+)/g;

function timeLabel(d: Date | null) {
  if (!d) return "";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay ? `Today ${time}` : `${d.toLocaleDateString()} ${time}`;
}

/** A file waiting to go with the next message, uploading as soon as it is picked. */
type Pending = { id: number; file: File; progress: number; done?: ChatFile; error?: string };
let pendingSeq = 0;

function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** A sent picture or video shows itself; any other file is a download card. */
function FileView(props: { file: ChatFile }) {
  const kind = () => props.file.type.split("/")[0];
  return (
    <Show
      when={kind() === "image" || kind() === "video" || kind() === "audio"}
      fallback={
        <a class="msg-file" href={props.file.url} target="_blank" rel="noopener noreferrer" download={props.file.name}>
          <span class="msg-file-icon" aria-hidden="true">
            ⇩
          </span>
          <span class="msg-file-text">
            <b>{props.file.name}</b>
            <small>{sizeLabel(props.file.size)}</small>
          </span>
        </a>
      }
    >
      <Show when={kind() === "image"}>
        <a class="msg-media" href={props.file.url} target="_blank" rel="noopener noreferrer">
          <img src={props.file.url} alt={props.file.name} loading="lazy" />
        </a>
      </Show>
      <Show when={kind() === "video"}>
        <video class="msg-media" src={props.file.url} controls preload="metadata" playsinline />
      </Show>
      <Show when={kind() === "audio"}>
        <audio class="msg-audio" src={props.file.url} controls preload="metadata" />
      </Show>
    </Show>
  );
}

/** Plain text with links made clickable. Nothing is parsed as HTML. */
function Text(props: { text: string }) {
  const parts = () => props.text.split(URL_RE);
  return (
    <For each={parts()}>
      {(part, i) =>
        i() % 2 === 1 ? (
          <a href={part} target="_blank" rel="noopener noreferrer">
            {part}
          </a>
        ) : (
          part
        )
      }
    </For>
  );
}

export function Chat(props: {
  serverId: string;
  channel: Channel;
  uid: string;
  profiles: Map<string, Profile>;
  canModerate: boolean;
  /** the narrow sidebar version beside a room tile */
  compact?: boolean;
  /** a message arrived after the chat had loaded (the right sidebar slides in) */
  onNewMessage?: () => void;
  /** a name or picture was clicked: show that person's profile card */
  onProfile?: (uid: string, at: MouseEvent) => void;
}) {
  const [messages, setMessages] = createSignal<Message[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [editing, setEditing] = createSignal<string | undefined>();
  const [draft, setDraft] = createSignal("");
  const [error, setError] = createSignal("");
  let scroller: HTMLDivElement | undefined;
  let input: HTMLTextAreaElement | undefined;
  let stickToBottom = true;

  createEffect(
    on(
      () => [props.serverId, props.channel.id] as const,
      ([sid, cid]) => {
        setMessages([]);
        setLoaded(false);
        setEditing(undefined);
        stickToBottom = true;
        let seen: Set<string> | undefined;
        const stop = watchMessages(sid, cid, (rows) => {
          // after the first load, any message not seen before is new
          if (seen && rows.some((r) => !seen!.has(r.id))) props.onNewMessage?.();
          seen = new Set(rows.map((r) => r.id));
          setMessages(rows);
          setLoaded(true);
        });
        onCleanup(stop);
        // the sidebar chat must not pull focus away from the call or the room
        if (!props.compact) queueMicrotask(() => input?.focus());
      },
    ),
  );

  // Follow new messages unless you have scrolled up to read.
  createEffect(
    on(messages, () => {
      if (!scroller || !stickToBottom) return;
      requestAnimationFrame(() => scroller && (scroller.scrollTop = scroller.scrollHeight));
    }),
  );
  const onScroll = () => {
    if (!scroller) return;
    stickToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  };

  const nameOf = (uid: string) => props.profiles.get(uid)?.name || props.profiles.get(uid)?.username || "Member";
  const startsGroup = (i: number) => {
    const list = messages();
    const prev = list[i - 1];
    const cur = list[i];
    if (!prev || prev.authorUid !== cur.authorUid) return true;
    return (cur.createdAt?.getTime() ?? 0) - (prev.createdAt?.getTime() ?? 0) > GROUP_MS;
  };

  // Pictures, videos and files: picked with the paperclip, dropped on the
  // chat, or pasted. Each starts uploading at once; Send waits for all.
  const [pending, setPending] = createSignal<Pending[]>([]);
  let filePicker: HTMLInputElement | undefined;
  const uploading = () => pending().some((f) => !f.done && !f.error);
  const ready = () => pending().filter((f) => f.done).map((f) => f.done!);
  const progressOf = () => {
    const busy = pending().filter((f) => !f.done && !f.error);
    return busy.length ? Math.round(busy.reduce((n, f) => n + f.progress, 0) / busy.length) : 100;
  };
  const patch = (id: number, change: Partial<Pending>) =>
    setPending((list) => list.map((f) => (f.id === id ? { ...f, ...change } : f)));

  function addFiles(files: FileList | File[] | null | undefined) {
    for (const file of Array.from(files ?? [])) {
      const id = ++pendingSeq;
      if (file.size > MAX_FILE_BYTES) {
        setPending((list) => [...list, { id, file, progress: 0, error: "Over 500 MB" }]);
        continue;
      }
      setPending((list) => [...list, { id, file, progress: 0 }]);
      uploadChatFile(props.serverId, props.channel.id, file, (progress) => patch(id, { progress }))
        .then((done) => patch(id, { done, progress: 100 }))
        .catch((err) => patch(id, { error: err instanceof Error ? err.message : "Upload failed" }));
    }
  }
  const dropFile = (id: number) => setPending((list) => list.filter((f) => f.id !== id));
  // another channel starts with nothing attached
  createEffect(on(() => props.channel.id, () => setPending([]), { defer: true }));

  async function send() {
    const text = draft().trim();
    const files = ready();
    if ((!text && !files.length) || uploading()) return;
    setDraft("");
    setPending([]);
    setError("");
    stickToBottom = true;
    try {
      await sendMessage(props.serverId, props.channel.id, props.uid, text.slice(0, 4000), files);
    } catch {
      setDraft(text);
      setError("Could not send. Check your connection.");
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div
      class="chat"
      classList={{ compact: props.compact }}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer?.files.length) return;
        e.preventDefault();
        addFiles(e.dataTransfer.files);
      }}
    >
      <div class="chat-scroll" ref={scroller} onScroll={onScroll}>
        <Show when={loaded() && !messages().length}>
          <div class="chat-start">
            <h2># {props.channel.name}</h2>
            <p>This is the start of the channel. Say hello.</p>
          </div>
        </Show>
        <For each={messages()}>
          {(m, i) => (
            <article class="msg" classList={{ grouped: !startsGroup(i()) }}>
              <Show when={startsGroup(i())}>
                <button
                  type="button"
                  class="avatar avatar-btn"
                  style={{ background: props.profiles.get(m.authorUid)?.color ?? "#404040" }}
                  aria-label={`${nameOf(m.authorUid)}'s profile`}
                  onClick={(e) => props.onProfile?.(m.authorUid, e)}
                >
                  {initials(nameOf(m.authorUid))}
                </button>
              </Show>
              <div class="msg-body">
                <Show when={startsGroup(i())}>
                  <header class="msg-head">
                    <b class="msg-author" onClick={(e) => props.onProfile?.(m.authorUid, e)}>
                      {nameOf(m.authorUid)}
                    </b>
                    <time>{timeLabel(m.createdAt)}</time>
                  </header>
                </Show>
                <Show
                  when={editing() === m.id}
                  fallback={
                    <>
                      <Show when={m.text}>
                        <p class="msg-text">
                          <Text text={m.text} />
                          <Show when={m.editedAt}>
                            <small class="edited"> (edited)</small>
                          </Show>
                        </p>
                      </Show>
                      <Show when={m.files.length}>
                        <div class="msg-files">
                          <For each={m.files}>{(file) => <FileView file={file} />}</For>
                        </div>
                      </Show>
                    </>
                  }
                >
                  <EditBox
                    text={m.text}
                    onCancel={() => setEditing(undefined)}
                    onSave={async (text) => {
                      await editMessage(props.serverId, props.channel.id, m.id, props.uid, text);
                      setEditing(undefined);
                    }}
                  />
                </Show>
              </div>
              <Show when={editing() !== m.id && (m.authorUid === props.uid || props.canModerate)}>
                <div class="msg-tools">
                  <Show when={m.authorUid === props.uid}>
                    <button class="icon-btn" type="button" title="Edit" aria-label="Edit message" onClick={() => setEditing(m.id)}>
                      ✎
                    </button>
                  </Show>
                  <button
                    class="icon-btn"
                    type="button"
                    title="Delete"
                    aria-label="Delete message"
                    onClick={() => void deleteMessage(props.serverId, props.channel.id, m.id)}
                  >
                    🗑
                  </button>
                </div>
              </Show>
            </article>
          )}
        </For>
      </div>
      <Show when={error()}>
        <p class="form-error chat-error">{error()}</p>
      </Show>
      <Show when={pending().length}>
        <div class="pending-files">
          <For each={pending()}>
            {(f) => (
              <div class="pending-file" classList={{ failed: Boolean(f.error) }}>
                <span class="pending-name">{f.file.name}</span>
                <small>{f.error ?? (f.done ? sizeLabel(f.file.size) : `${Math.round(f.progress)}%`)}</small>
                <button type="button" class="icon-btn" aria-label={`Remove ${f.file.name}`} onClick={() => dropFile(f.id)}>
                  ✕
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <div class="composer">
        <input
          ref={filePicker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.currentTarget.files);
            e.currentTarget.value = "";
          }}
        />
        <button
          class="icon-btn attach"
          type="button"
          title="Send a picture, video or file"
          aria-label="Attach a picture, video or file"
          onClick={() => filePicker?.click()}
        >
          📎
        </button>
        <textarea
          ref={input}
          rows={1}
          value={draft()}
          placeholder={`Message #${props.channel.name}`}
          aria-label={`Message #${props.channel.name}`}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={onKey}
          onPaste={(e) => {
            const files = e.clipboardData?.files;
            if (files?.length) {
              e.preventDefault();
              addFiles(files);
            }
          }}
        />
        <button
          class="btn primary send"
          type="button"
          disabled={uploading() || (!draft().trim() && !ready().length)}
          onClick={() => void send()}
        >
          {uploading() ? `${progressOf()}%` : "Send"}
        </button>
      </div>
    </div>
  );
}

function EditBox(props: { text: string; onSave: (text: string) => Promise<void>; onCancel: () => void }) {
  const [value, setValue] = createSignal(props.text);
  return (
    <div class="edit-box">
      <textarea
        value={value()}
        ref={(el) => queueMicrotask(() => el.focus())}
        onInput={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onCancel();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            const text = value().trim();
            if (text) void props.onSave(text);
          }
        }}
      />
      <small>Enter to save · Esc to cancel</small>
    </div>
  );
}
