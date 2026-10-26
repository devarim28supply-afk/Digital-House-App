import { type JSX, For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import {
  type Feedback,
  type FeedbackStatus,
  type FeedbackType,
  feedbackContext,
  replyToFeedback,
  sendFeedback,
  setFeedbackStatus,
  uploadFeedbackFile,
  watchAllFeedback,
  watchMyFeedback,
} from "../data/feedback";
import type { ChatFile } from "../data/store";
import { Modal } from "./Modal";

const TYPES: { id: FeedbackType; label: string }[] = [
  { id: "bug", label: "Bug" },
  { id: "idea", label: "Idea" },
  { id: "other", label: "Other" },
];
const STATUS_LABEL: Record<FeedbackStatus, string> = { new: "New", working: "Working on it", done: "Done" };
const when = (d: Date | null) => (d ? d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "just now");

/**
 * Feedback for the developers: Send (bug / idea / other, text, screenshots
 * or files, where you are added by itself), My feedback (your own, with the
 * status and reply), and for the owner and admins the Inbox of everyone's.
 */
export function FeedbackDialog(props: {
  open: boolean;
  initialTab?: "send" | "mine" | "inbox";
  notifications?: JSX.Element;
  onClose: () => void;
  uid: string;
  name: string;
  username: string;
  admin: boolean;
  /** where they are, added to what they send (a channel, a tile, the room) */
  where: string;
}) {
  const [tab, setTab] = createSignal<"send" | "mine" | "inbox" | "notifications">("send");
  createEffect(() => { if (props.open) setTab(props.initialTab ?? "send"); });
  return (
    <Modal title="Feedback" open={props.open} onClose={props.onClose}>
      <div class="fb">
        <div class="fb-tabs" role="tablist">
          <button type="button" role="tab" aria-pressed={tab() === "send"} onClick={() => setTab("send")}>
            Send
          </button>
          <button type="button" role="tab" aria-pressed={tab() === "mine"} onClick={() => setTab("mine")}>
            My feedback
          </button>
          <button type="button" role="tab" aria-pressed={tab() === "notifications"} onClick={() => setTab("notifications")}>Notifications</button>
          <Show when={props.admin}>
            <button type="button" role="tab" aria-pressed={tab() === "inbox"} onClick={() => setTab("inbox")}>
              Inbox
            </button>
          </Show>
        </div>
        <Show when={tab() === "notifications"}>{props.notifications}</Show>
        <Show when={tab() === "send"}>
          <SendForm {...props} onSent={() => setTab("mine")} />
        </Show>
        <Show when={tab() === "mine"}>
          <MyFeedback uid={props.uid} />
        </Show>
        <Show when={tab() === "inbox" && props.admin}>
          <Inbox by={props.username || props.name} />
        </Show>
      </div>
    </Modal>
  );
}

function SendForm(props: { uid: string; name: string; username: string; where: string; onSent: () => void }) {
  const [type, setType] = createSignal<FeedbackType>("bug");
  const [text, setText] = createSignal("");
  const [files, setFiles] = createSignal<ChatFile[]>([]);
  const [progress, setProgress] = createSignal<number | null>(null);
  const [error, setError] = createSignal("");
  const [sending, setSending] = createSignal(false);

  async function addFiles(list: FileList | null) {
    for (const file of Array.from(list ?? [])) {
      setError("");
      setProgress(0);
      try {
        const f = await uploadFeedbackFile(file, (p) => setProgress(Math.round(p)));
        setFiles((prev) => [...prev, f]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not upload that file.");
      } finally {
        setProgress(null);
      }
    }
  }

  async function send(e: Event) {
    e.preventDefault();
    const body = text().trim().slice(0, 5000);
    if (!body) return setError("Write what happened or what you would like.");
    setSending(true);
    setError("");
    try {
      await sendFeedback({
        uid: props.uid,
        name: props.name,
        username: props.username,
        type: type(),
        text: body,
        files: files(),
        context: feedbackContext(props.where),
      });
      setText("");
      setFiles([]);
      props.onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send it.");
    } finally {
      setSending(false);
    }
  }

  return (
    <form class="modal-form" onSubmit={send}>
      <p class="modal-text">Tell the developers about a bug, an idea, or anything else about Darkwood Node.</p>
      <div class="fb-types">
        <For each={TYPES}>
          {(t) => (
            <button type="button" aria-pressed={type() === t.id} onClick={() => setType(t.id)}>
              {t.label}
            </button>
          )}
        </For>
      </div>
      <label class="field">
        <span>{type() === "bug" ? "What happened, and what did you expect?" : "Your feedback"}</span>
        <textarea class="fb-text" rows={6} maxLength={5000} value={text()} onInput={(e) => setText(e.currentTarget.value)} />
      </label>
      <label class="field">
        <span>Screenshots or files (optional, up to 50 MB each)</span>
        <input type="file" multiple onChange={(e) => void addFiles(e.currentTarget.files)} />
      </label>
      <Show when={progress() !== null}>
        <p class="modal-text">Uploading… {progress()}%</p>
      </Show>
      <Show when={files().length}>
        <ul class="fb-files">
          <For each={files()}>
            {(f) => (
              <li>
                {f.name}{" "}
                <button type="button" class="icon-btn" aria-label={`Remove ${f.name}`} onClick={() => setFiles((prev) => prev.filter((x) => x !== f))}>
                  ✕
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <p class="fb-where">Also sent: where you are ({props.where}), your browser and screen size.</p>
      <Show when={error()}>
        <p class="form-error">{error()}</p>
      </Show>
      <div class="modal-actions">
        <button class="btn primary" type="submit" disabled={sending() || progress() !== null}>
          {sending() ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}

function Files(props: { files: ChatFile[] }) {
  return (
    <Show when={props.files.length}>
      <div class="fb-attach">
        <For each={props.files}>
          {(f) =>
            f.type.startsWith("image/") ? (
              <a href={f.url} target="_blank" rel="noopener">
                <img src={f.url} alt={f.name} />
              </a>
            ) : (
              <a href={f.url} target="_blank" rel="noopener">
                {f.name}
              </a>
            )
          }
        </For>
      </div>
    </Show>
  );
}

function MyFeedback(props: { uid: string }) {
  const [list, setList] = createSignal<Feedback[] | null>(null);
  createEffect(() => {
    const stop = watchMyFeedback(props.uid, setList);
    onCleanup(stop);
  });
  return (
    <div class="fb-list">
      <Show when={list()} fallback={<p class="modal-text">Loading…</p>}>
        <Show when={list()!.length} fallback={<p class="modal-text">You have not sent any feedback yet.</p>}>
          <For each={list()!}>
            {(f) => (
              <article class="fb-item">
                <header>
                  <span class={`fb-badge ${f.type}`}>{f.type}</span>
                  <span class={`fb-status ${f.status}`}>{STATUS_LABEL[f.status]}</span>
                  <time>{when(f.createdAt)}</time>
                </header>
                <p class="fb-body">{f.text}</p>
                <Files files={f.files} />
                <Show when={f.reply}>
                  <p class="fb-reply">
                    <b>Developers:</b> {f.reply}
                  </p>
                </Show>
              </article>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}

function Inbox(props: { by: string }) {
  const [list, setList] = createSignal<Feedback[] | null>(null);
  const [error, setError] = createSignal("");
  const [type, setType] = createSignal<FeedbackType | "all">("all");
  const [status, setStatus] = createSignal<FeedbackStatus | "open" | "all">("open");
  createEffect(() => {
    const stop = watchAllFeedback(setList, (err) => setError(err.message));
    onCleanup(stop);
  });
  const shown = createMemo(() =>
    (list() ?? []).filter(
      (f) =>
        (type() === "all" || f.type === type()) &&
        (status() === "all" || (status() === "open" ? f.status !== "done" : f.status === status())),
    ),
  );
  return (
    <div class="fb-list">
      <div class="fb-filters">
        <select value={type()} onChange={(e) => setType(e.currentTarget.value as FeedbackType | "all")} aria-label="Type">
          <option value="all">All types</option>
          <option value="bug">Bugs</option>
          <option value="idea">Ideas</option>
          <option value="other">Other</option>
        </select>
        <select value={status()} onChange={(e) => setStatus(e.currentTarget.value as FeedbackStatus | "open" | "all")} aria-label="Status">
          <option value="open">Not done</option>
          <option value="new">New</option>
          <option value="working">Working on it</option>
          <option value="done">Done</option>
          <option value="all">All</option>
        </select>
        <span class="fb-count">{shown().length}</span>
      </div>
      <Show when={error()}>
        <p class="form-error">
          Could not load the inbox: {error()}. (The new feedback rule may not be published yet.)
        </p>
      </Show>
      <Show when={list()} fallback={<Show when={!error()}><p class="modal-text">Loading…</p></Show>}>
        <Show when={shown().length} fallback={<p class="modal-text">Nothing here.</p>}>
          <For each={shown()}>{(f) => <InboxItem f={f} by={props.by} />}</For>
        </Show>
      </Show>
    </div>
  );
}

function InboxItem(props: { f: Feedback; by: string }) {
  const [reply, setReply] = createSignal(props.f.reply ?? "");
  const [saving, setSaving] = createSignal(false);
  const [result, setResult] = createSignal("");
  const [replyError, setReplyError] = createSignal("");
  const [open, setOpen] = createSignal(false);
  return (
    <article class="fb-item" classList={{ done: props.f.status === "done" }}>
      <header>
        <span class={`fb-badge ${props.f.type}`}>{props.f.type}</span>
        <b>{props.f.username || props.f.name || "someone"}</b>
        <time>{when(props.f.createdAt)}</time>
        <FeedbackStatusPicker id={props.f.id} status={props.f.status} />
      </header>
      <p class="fb-body">{props.f.text}</p>
      <Files files={props.f.files} />
      <button type="button" class="fb-more" onClick={() => setOpen(!open())}>
        {open() ? "Hide details" : "Details"}
      </button>
      <Show when={open()}>
        <dl class="fb-context">
          <dt>Where</dt>
          <dd>{props.f.context.where}</dd>
          <dt>Page</dt>
          <dd>{props.f.context.page}</dd>
          <dt>Screen</dt>
          <dd>{props.f.context.screen}</dd>
          <dt>Browser</dt>
          <dd>{props.f.context.browser}</dd>
        </dl>
      </Show>
      <form
        class="fb-reply-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const text = reply().trim();
          if (!text || saving()) return;
          const updating = Boolean(props.f.reply);
          setResult(""); setReplyError("");
          setSaving(true);
          try {
            await replyToFeedback(props.f.id, text.slice(0, 2000), props.by);
            setResult(updating ? "Reply updated" : "Reply sent");
          } catch (error) {
            setReplyError(error instanceof Error ? error.message : "Could not send your reply. Try again.");
          } finally {
            setSaving(false);
          }
        }}
      >
        <input
          placeholder="Reply (they see it in My feedback)"
          value={reply()}
          disabled={saving()}
          onInput={(e) => {setReply(e.currentTarget.value);setResult("");setReplyError("");}}
          maxLength={2000}
        />
        <button class="btn fb-reply-submit" classList={{ "is-saved": Boolean(result()) }} type="submit" disabled={saving() || !reply().trim()} aria-busy={saving()}>
          {saving() ? "Sending…" : result() ? "✓ Saved" : props.f.reply ? "Update" : "Reply"}
        </button>
      </form>
      <Show when={result()}><p class="fb-reply-result" role="status" aria-live="polite">✓ {result()} successfully.</p></Show>
      <Show when={replyError()}><p class="form-error" role="alert">{replyError()}</p></Show>
    </article>
  );
}

function FeedbackStatusPicker(props: { id: string; status: FeedbackStatus }) {
  const [open, setOpen] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  let host: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  createEffect(() => {
    if (!open()) return;
    const outside = (event: PointerEvent) => {if (!host?.contains(event.target as Node)) setOpen(false);};
    document.addEventListener("pointerdown",outside);
    queueMicrotask(() => host?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus());
    onCleanup(() => document.removeEventListener("pointerdown",outside));
  });
  async function choose(status: FeedbackStatus) {
    if(saving()) return;
    setSaving(true);setError("");
    try {await setFeedbackStatus(props.id,status);setOpen(false);trigger?.focus();}
    catch {setError("Could not update status. Try again.");}
    finally {setSaving(false);}
  }
  return <div class="fb-status-dropdown" ref={host} onKeyDown={event => {
    if(event.key === "Escape") {setOpen(false);trigger?.focus();event.preventDefault();}
    if(open() && ["ArrowDown","ArrowUp","Home","End"].includes(event.key)) {
      const options = Array.from(host!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
      const at=options.indexOf(document.activeElement as HTMLButtonElement);
      const next=event.key === "Home" ? 0 : event.key === "End" ? options.length-1 : (at+(event.key === "ArrowDown" ? 1 : -1)+options.length)%options.length;
      options[next]?.focus();event.preventDefault();
    }
  }}>
    <button ref={trigger} class="fb-status-trigger" type="button" aria-label={`Status: ${STATUS_LABEL[props.status]}`} aria-haspopup="menu" aria-expanded={open()} disabled={saving()} onClick={() => setOpen(!open())}>{saving() ? "Saving…" : STATUS_LABEL[props.status]}<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>
    <Show when={open()}><div class="fb-status-menu" role="menu" aria-label="Feedback status"><For each={(["new","working","done"] as FeedbackStatus[])}>{status => <button type="button" role="menuitemradio" aria-checked={props.status === status} disabled={saving()} onClick={() => void choose(status)}><span>{STATUS_LABEL[status]}</span><span aria-hidden="true">{props.status === status ? "✓" : ""}</span></button>}</For><Show when={error()}><p role="alert">{error()}</p></Show></div></Show>
  </div>;
}
