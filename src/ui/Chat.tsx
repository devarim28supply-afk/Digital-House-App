import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";

import {
  type Channel,
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
        const stop = watchMessages(sid, cid, (rows) => {
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

  async function send() {
    const text = draft().trim();
    if (!text) return;
    setDraft("");
    setError("");
    stickToBottom = true;
    try {
      await sendMessage(props.serverId, props.channel.id, props.uid, text.slice(0, 4000));
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
    <div class="chat" classList={{ compact: props.compact }}>
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
                <span class="avatar" style={{ background: props.profiles.get(m.authorUid)?.color ?? "#404040" }}>
                  {initials(nameOf(m.authorUid))}
                </span>
              </Show>
              <div class="msg-body">
                <Show when={startsGroup(i())}>
                  <header class="msg-head">
                    <b>{nameOf(m.authorUid)}</b>
                    <time>{timeLabel(m.createdAt)}</time>
                  </header>
                </Show>
                <Show
                  when={editing() === m.id}
                  fallback={
                    <p class="msg-text">
                      <Text text={m.text} />
                      <Show when={m.editedAt}>
                        <small class="edited"> (edited)</small>
                      </Show>
                    </p>
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
      <div class="composer">
        <textarea
          ref={input}
          rows={1}
          value={draft()}
          placeholder={`Message #${props.channel.name}`}
          aria-label={`Message #${props.channel.name}`}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={onKey}
        />
        <button class="btn primary send" type="button" disabled={!draft().trim()} onClick={() => void send()}>
          Send
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
