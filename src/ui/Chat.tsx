import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";

import { MAX_FILE_BYTES, uploadChatFile } from "../data/files";
import {
  type Channel,
  type ChatFile,
  type Emoji,
  type Message,
  type Profile,
  type Sticker,
  deleteMessage,
  editMessage,
  reactToMessage,
  sendMessage,
  watchMessages,
} from "../data/store";
import { audit } from "../data/audit";
import { EmojiPicker, ImageViewer } from "./Emoji";
import { faceStyle, faceText } from "./Shell";

// Messages from the same person within this gap share one header.
const GROUP_MS = 5 * 60_000;
const URL_RE = /(https?:\/\/[^\s<]+)/g;

function timeLabel(d: Date | null) {
  if (!d) return "";
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const time = shortTime(d);
  if (d.toDateString() === today.toDateString()) return `Today at ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString()} ${time}`;
}

const shortTime = (d: Date | null) => (d ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
// the full date and time, shown when you hover any time
const fullTime = (d: Date | null) =>
  d ? d.toLocaleString([], { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";

const EMOJI_TOKEN = /(:[a-z0-9_]{2,32}:)/g;
// a message of only emojis (and spaces) shows them big, like Discord
const ONLY_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\ufe0f|\s|:[a-z0-9_]{2,32}:)+$/u;

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
function FileView(props: { file: ChatFile; onOpen: (file: ChatFile) => void }) {
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
        <button type="button" class="msg-media" title="Open" onClick={() => props.onOpen(props.file)}>
          <img src={props.file.url} alt={props.file.name} loading="lazy" />
        </button>
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

/**
 * Plain text with links made clickable and :name: shown as the server's
 * emoji. Nothing is parsed as HTML.
 */
const MENTION = /(@[A-Za-z0-9_.-]{2,32})/g;

/** One run of plain text: server emojis as pictures, @mentions highlighted. */
function Bits(props: { text: string; emojis: Map<string, Emoji>; usernames: Set<string>; me: string }) {
  return (
    <For each={props.text.split(EMOJI_TOKEN)}>
      {(bit) => {
        const emoji = /^:[a-z0-9_]{2,32}:$/.test(bit) ? props.emojis.get(bit.slice(1, -1)) : undefined;
        if (emoji) return <img class="emoji" src={emoji.url} alt={bit} title={bit} />;
        return (
          <For each={bit.split(MENTION)}>
            {(word) => {
              const name = word.startsWith("@") ? word.slice(1).toLowerCase() : "";
              return name && (name === "everyone" || props.usernames.has(name)) ? (
                <span class="mention" classList={{ me: name === "everyone" || name === props.me }}>
                  {word}
                </span>
              ) : (
                word
              );
            }}
          </For>
        );
      }}
    </For>
  );
}

function Text(props: { text: string; emojis: Map<string, Emoji>; usernames: Set<string>; me: string }) {
  const parts = () => props.text.split(URL_RE);
  return (
    <For each={parts()}>
      {(part, i) =>
        i() % 2 === 1 ? (
          <a href={part} target="_blank" rel="noopener noreferrer">
            {part}
          </a>
        ) : (
          <Bits text={part} emojis={props.emojis} usernames={props.usernames} me={props.me} />
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
  /**
   * Take files dropped ANYWHERE on the page (the sidebar chat): a file
   * dragged in from a folder slides the sidebar in (onDragging), and the drop
   * lands here instead of the browser opening the file.
   */
  catchPageDrops?: boolean;
  onDragging?: (on: boolean) => void;
  /** the server's own emojis (:name:) */
  emojis?: Emoji[];
  /** who is in this server: the people @ can mention */
  members?: string[];
}) {
  const emojiMap = createMemo(
    () => new Map((props.emojis ?? []).filter((e) => e.kind !== "sticker").map((e) => [e.name, e])),
  );

  /** A sticker goes on its own, right away, like Discord. */
  async function sendSticker(sticker: Sticker) {
    setPicker(false);
    stickToBottom = true;
    try {
      await sendMessage(props.serverId, props.channel.id, props.uid, "", [], sticker);
    } catch {
      setError("Could not send. Check your connection.");
    }
  }
  const [viewing, setViewing] = createSignal<ChatFile | undefined>();
  const [picker, setPicker] = createSignal(false);
  // the message a reaction is being picked for (the ☺+ button)
  const [reactingTo, setReactingTo] = createSignal<string | undefined>();
  const react = (m: Message, emoji: string) => {
    const mine = (m.reactions[emoji] ?? []).includes(props.uid);
    void reactToMessage(props.serverId, props.channel.id, m.id, props.uid, emoji, !mine).catch(() =>
      setError("Could not react. Check your connection."),
    );
  };
  const jumbo = (text: string) => ONLY_EMOJI.test(text) && [...text.replace(/\s/g, "")].length <= 54;
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
  // Another chat: start empty. By server AND channel (every DM's chat is
  // "chat"), and the half-written text too, so words meant for one person
  // are never sent to another.
  createEffect(
    on(
      () => `${props.serverId}/${props.channel.id}`,
      () => {
        setPending([]);
        setDraft("");
      },
      { defer: true },
    ),
  );

  async function send() {
    const text = draft().trim();
    const files = ready();
    if ((!text && !files.length) || uploading()) return;
    const sent = pending();
    const where = `${props.serverId}/${props.channel.id}`;
    setDraft("");
    setPending([]);
    setError("");
    stickToBottom = true;
    try {
      await sendMessage(props.serverId, props.channel.id, props.uid, text.slice(0, 4000), files);
    } catch {
      // Put back the words and the attached files, so a retry sends both,
      // but only into the same chat: switched away meanwhile, they would
      // land (and be sent) somewhere they were never meant for.
      if (`${props.serverId}/${props.channel.id}` !== where) return;
      setDraft(text);
      setPending((now) => [...sent, ...now]);
      setError("Could not send. Check your connection.");
    }
  }

  function insertAtCursor(text: string) {
    const el = input;
    const value = draft();
    const at = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const before = value.slice(0, at);
    const pad = text.startsWith(":") && before && !/\s$/.test(before) ? " " : "";
    setDraft(before + pad + text + value.slice(end));
    queueMicrotask(() => {
      if (!el) return;
      el.focus();
      const pos = at + pad.length + text.length;
      el.setSelectionRange(pos, pos);
    });
  }

  // ---- @mentions -----------------------------------------------------------
  // my own username (lowercase): messages naming me (or @everyone) light up
  const me = () => (props.profiles.get(props.uid)?.username ?? "").toLowerCase();
  const usernames = createMemo(
    () => new Set([...props.profiles.values()].map((p) => (p.username ?? "").toLowerCase()).filter(Boolean)),
  );
  const mentionsMe = (m: Message) => {
    if (m.authorUid === props.uid) return false;
    // every @word in the message, whole words only
    const named: string[] = m.text.toLowerCase().match(/@[a-z0-9_.-]+/g) ?? [];
    return named.includes("@everyone") || (me() !== "" && named.includes(`@${me()}`));
  };
  // typing "@na…": the people to pick from
  const [mentionQuery, setMentionQuery] = createSignal<string | undefined>();
  const [mentionPick, setMentionPick] = createSignal(0);
  const mentionList = createMemo(() => {
    const q = mentionQuery();
    if (q === undefined) return [];
    const people = (props.members ?? [...props.profiles.keys()])
      .filter((uid) => uid !== props.uid)
      .map((uid) => props.profiles.get(uid))
      .filter((p): p is Profile => Boolean(p?.username))
      .map((p) => ({ username: p.username, label: p.name || p.username, profile: p as Profile | undefined }));
    const all = [{ username: "everyone", label: "Everyone here", profile: undefined }, ...people];
    const query = q.toLowerCase();
    return all.filter((x) => x.username.toLowerCase().startsWith(query) || x.label.toLowerCase().includes(query)).slice(0, 8);
  });
  function findMention() {
    const el = input;
    if (!el) return setMentionQuery(undefined);
    const before = el.value.slice(0, el.selectionStart ?? el.value.length);
    const found = /(?:^|\s)@([A-Za-z0-9_.-]{0,32})$/.exec(before);
    setMentionQuery(found ? found[1] : undefined);
    setMentionPick(0);
  }
  function insertMention(username: string) {
    const el = input;
    if (!el) return;
    const at = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, at).replace(/@([A-Za-z0-9_.-]{0,32})$/, `@${username} `);
    const next = before + el.value.slice(at);
    setDraft(next);
    setMentionQuery(undefined);
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  }

  function onKey(e: KeyboardEvent) {
    // the @ list is open: arrows pick, Enter or Tab puts it in, Esc closes
    if (mentionList().length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = mentionList().length;
        setMentionPick((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
        e.preventDefault();
        insertMention(mentionList()[mentionPick()].username);
        return;
      }
      if (e.key === "Escape") {
        setMentionQuery(undefined);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  // Files dragged from a folder: over this chat, or (catchPageDrops) over
  // any part of the page. A counter, because dragenter/dragleave fire for
  // every child element the drag crosses.
  const [dragging, setDragging] = createSignal(false);
  createEffect(() => props.onDragging?.(dragging()));
  const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes("Files"));
  function onFileDrop(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer?.files);
    // the message box takes the cursor, which keeps the sidebar in: type a
    // note if you like, Enter sends
    input?.focus();
  }
  onMount(() => {
    if (!props.catchPageDrops) return;
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      depth = 0;
      onFileDrop(e);
    };
    const end = () => {
      depth = 0;
      setDragging(false);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    window.addEventListener("dragend", end);
    onCleanup(() => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
      window.removeEventListener("dragend", end);
      props.onDragging?.(false);
    });
  });

  return (
    <div
      class="chat"
      classList={{ compact: props.compact, "drag-over": dragging() }}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault();
      }}
      onDrop={(e) => {
        // the page-wide listener takes it when it is on
        if (props.catchPageDrops) return;
        onFileDrop(e);
      }}
    >
      <Show when={dragging()}>
        <div class="drop-hint" aria-hidden="true">
          <span>Drop to send in # {props.channel.name}</span>
        </div>
      </Show>
      <div class="chat-scroll" ref={scroller} onScroll={onScroll}>
        <Show when={loaded() && !messages().length}>
          <div class="chat-start">
            <h2># {props.channel.name}</h2>
            <p>This is the start of the channel. Say hello.</p>
          </div>
        </Show>
        <For each={messages()}>
          {(m, i) => (
            <article class="msg" classList={{ grouped: !startsGroup(i()), "mentions-me": mentionsMe(m) }}>
              <Show when={startsGroup(i())}>
                <button
                  type="button"
                  class="avatar avatar-btn"
                  style={faceStyle(props.profiles.get(m.authorUid))}
                  aria-label={`${nameOf(m.authorUid)}'s profile`}
                  onClick={(e) => props.onProfile?.(m.authorUid, e)}
                >
                  {faceText(props.profiles.get(m.authorUid), nameOf(m.authorUid))}
                </button>
              </Show>
              <Show when={!startsGroup(i())}>
                <time class="msg-side-time" title={fullTime(m.createdAt)}>
                  {shortTime(m.createdAt)}
                </time>
              </Show>
              <div class="msg-body">
                <Show when={startsGroup(i())}>
                  <header class="msg-head">
                    <b class="msg-author" onClick={(e) => props.onProfile?.(m.authorUid, e)}>
                      {nameOf(m.authorUid)}
                    </b>
                    <time title={fullTime(m.createdAt)}>{timeLabel(m.createdAt)}</time>
                  </header>
                </Show>
                <Show
                  when={editing() === m.id}
                  fallback={
                    <>
                      <Show when={m.text}>
                        <p class="msg-text" classList={{ jumbo: jumbo(m.text) }}>
                          <Text text={m.text} emojis={emojiMap()} usernames={usernames()} me={me()} />
                          <Show when={m.editedAt}>
                            <small class="edited"> (edited)</small>
                          </Show>
                        </p>
                      </Show>
                      <Show when={m.sticker}>
                        {(sticker) => (
                          <img class="msg-sticker" src={sticker().url} alt={sticker().name} title={sticker().name} loading="lazy" />
                        )}
                      </Show>
                      <Show when={Object.values(m.reactions).some((who) => who.length)}>
                        <div class="msg-reactions">
                          <For each={Object.entries(m.reactions).filter(([, who]) => who.length)}>
                            {([emoji, who]) => (
                              <button
                                type="button"
                                class="reaction"
                                classList={{ mine: who.includes(props.uid) }}
                                title={who.map(nameOf).join(", ")}
                                onClick={() => react(m, emoji)}
                              >
                                <Show
                                  when={/^:[a-z0-9_]{2,32}:$/.test(emoji) && emojiMap().get(emoji.slice(1, -1))}
                                  fallback={<span>{emoji}</span>}
                                >
                                  {(custom) => <img class="emoji" src={custom().url} alt={emoji} />}
                                </Show>
                                <small>{who.length}</small>
                              </button>
                            )}
                          </For>
                          <button
                            type="button"
                            class="reaction add"
                            title="Add a reaction"
                            onClick={() => {
                              setPicker(false);
                              setReactingTo(m.id);
                            }}
                          >
                            ☺+
                          </button>
                        </div>
                      </Show>
                      <Show when={m.files.length}>
                        <div class="msg-files">
                          <For each={m.files}>{(file) => <FileView file={file} onOpen={setViewing} />}</For>
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
              <Show when={editing() !== m.id}>
                <div class="msg-tools">
                  <button
                    class="icon-btn"
                    type="button"
                    title="Add a reaction"
                    aria-label="Add a reaction"
                    onClick={() => {
                      setPicker(false);
                      setReactingTo(m.id);
                    }}
                  >
                    ☺+
                  </button>
                  <Show when={m.authorUid === props.uid}>
                    <button class="icon-btn" type="button" title="Edit" aria-label="Edit message" onClick={() => setEditing(m.id)}>
                      ✎
                    </button>
                  </Show>
                  <Show when={m.authorUid === props.uid || props.canModerate}>
                    <button
                      class="icon-btn"
                      type="button"
                      title="Delete"
                      aria-label="Delete message"
                      onClick={() =>
                        void deleteMessage(props.serverId, props.channel.id, m.id).then(() => {
                          // someone else's message: that goes in the action log
                          if (m.authorUid !== props.uid)
                            audit("message.delete", {
                              serverId: props.serverId,
                              target: m.authorUid,
                              detail: `#${props.channel.name}: ${m.text.slice(0, 120)}`,
                            });
                        })
                      }
                    >
                      🗑
                    </button>
                  </Show>
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
      <Show when={picker()}>
        <EmojiPicker
          serverId={props.serverId}
          uid={props.uid}
          emojis={props.emojis ?? []}
          canModerate={props.canModerate}
          onPick={insertAtCursor}
          onSticker={(sticker) => void sendSticker(sticker)}
          onClose={() => setPicker(false)}
        />
      </Show>
      <Show when={mentionList().length}>
        <div class="mention-list" role="listbox" aria-label="Mention someone">
          <For each={mentionList()}>
            {(x, i) => (
              <button
                type="button"
                role="option"
                aria-selected={i() === mentionPick()}
                classList={{ picked: i() === mentionPick() }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(x.username);
                }}
              >
                <span class="avatar small" style={faceStyle(x.profile)}>
                  {x.profile ? faceText(x.profile, x.label) : "@"}
                </span>
                <b>{x.label}</b>
                <small>@{x.username}</small>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={reactingTo()}>
        {(mid) => (
          <EmojiPicker
            serverId={props.serverId}
            uid={props.uid}
            emojis={props.emojis ?? []}
            canModerate={props.canModerate}
            reactOnly
            onPick={(emoji) => {
              const m = messages().find((x) => x.id === mid());
              setReactingTo(undefined);
              if (m && !(m.reactions[emoji] ?? []).includes(props.uid)) react(m, emoji);
            }}
            onClose={() => setReactingTo(undefined)}
          />
        )}
      </Show>
      <Show when={viewing()}>
        {(file) => <ImageViewer url={file().url} name={file().name} onClose={() => setViewing(undefined)} />}
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
        <button
          class="icon-btn emoji-btn"
          type="button"
          title="Emojis"
          aria-label="Emojis"
          aria-expanded={picker()}
          onClick={() => setPicker(!picker())}
        >
          😀
        </button>
        <textarea
          ref={input}
          rows={1}
          value={draft()}
          placeholder={`Message #${props.channel.name}`}
          aria-label={`Message #${props.channel.name}`}
          onInput={(e) => {
            setDraft(e.currentTarget.value);
            findMention();
          }}
          onClick={findMention}
          onBlur={() => window.setTimeout(() => setMentionQuery(undefined), 150)}
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
