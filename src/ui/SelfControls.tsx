import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { DeveloperBadge } from "./DeveloperBadge";
import { faceStyle, faceText } from "./Shell";
import { clearNote, saveAvailability, saveNote, type Profile } from "../data/store";
import { Modal } from "./Modal";
import { AVAILABILITY_OPTIONS, availabilityStatus, availabilityLabel, type Availability } from "../data/status";
import { activeCall, microphoneEnabled, deafened, audioBusy, audioError, toggleMicrophone, toggleDeafen } from "../data/callControls";
import "./self-controls.css";

export function SelfControls(props: { note?: { emoji: string; text: string }; uid: string; profile?: Profile; name: string; onProfile: (event: MouseEvent) => void; onAccount: () => void }) {
  const [statusOpen, setStatusOpen] = createSignal(false);
  const [statusBusy, setStatusBusy] = createSignal(false);
  const [statusError, setStatusError] = createSignal("");
  const [status, setStatus] = createSignal(availabilityStatus(props.profile?.availability));
  createEffect(() => setStatus(availabilityStatus(props.profile?.availability)));
  // your custom status: a line of your own with an emoji (as in the desktop app)
  const NOTE_EMOJIS = ["", "🎮", "💻", "🎬", "🍔", "😴", "📚", "🎧", "🚗", "🏋️", "🔥", "❤️", "😎", "🤒", "🙏", "✈️"];
  const CLEAR_AFTER = [[0, "Don't clear"], [30, "30 minutes"], [60, "1 hour"], [240, "4 hours"], [-1, "Today"]] as const;
  const [noteOpen, setNoteOpen] = createSignal(false);
  const [noteEmoji, setNoteEmoji] = createSignal("");
  const [noteText, setNoteText] = createSignal("");
  const [noteAfter, setNoteAfter] = createSignal<number>(0);
  const [noteBusy, setNoteBusy] = createSignal(false);
  const [noteError, setNoteError] = createSignal("");
  function openNote() {
    setStatusOpen(false);
    setNoteEmoji(props.note?.emoji ?? ""); setNoteText(props.note?.text ?? ""); setNoteAfter(0); setNoteError("");
    setNoteOpen(true);
  }
  async function saveMyNote(clear = false) {
    const text = noteText().trim().slice(0, 80);
    setNoteBusy(true); setNoteError("");
    try {
      if (clear || (!text && !noteEmoji())) await clearNote(props.uid);
      else {
        const now = new Date();
        const until = noteAfter() === 0 ? 0 : noteAfter() === -1 ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() : Date.now() + noteAfter() * 60_000;
        await saveNote(props.uid, noteEmoji(), text, until);
      }
      setNoteOpen(false);
    } catch { setNoteError("Your status could not be saved. Check your connection and try again."); }
    finally { setNoteBusy(false); }
  }
  let statusButton: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  createEffect(() => {
    if (!statusOpen()) return;
    const outside = (event: PointerEvent) => {
      if (!menu?.contains(event.target as Node) && !statusButton?.contains(event.target as Node)) setStatusOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setStatusOpen(false); statusButton?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    queueMicrotask(() => menu?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
    onCleanup(() => { document.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); });
  });
  async function chooseStatus(next: Availability) {
    setStatusBusy(true); setStatusError("");
    try { await saveAvailability(props.uid, next); setStatus(next); setStatusOpen(false); statusButton?.focus(); }
    catch { setStatusError("Could not save your status. Check your connection and try again."); }
    finally { setStatusBusy(false); }
  }
  return <>
    <button ref={statusButton} class="self-profile-status" type="button" title={`Status: ${availabilityLabel(status())}`} aria-label={`Change status: ${availabilityLabel(status())}`} aria-haspopup="menu" aria-expanded={statusOpen()} onClick={() => setStatusOpen(!statusOpen())}>
      <span class="avatar" style={faceStyle(props.profile, "#526775")}>{faceText(props.profile, props.name)}<i class={`dot status-${status()}`} aria-hidden="true" /></span>
    </button>
    <button class="me-names profile-name-trigger" type="button" aria-label="Open my profile" onClick={props.onProfile}><b><span class="self-display-name">{props.name}</span><DeveloperBadge username={props.profile?.username} /></b><Show when={props.note}>{(note) => <small class="self-note">{`${note().emoji} ${note().text}`.trim()}</small>}</Show></button>
    <div class="self-controls">
      <button class="icon-btn self-audio-btn" classList={{ "is-off": !microphoneEnabled() }} type="button" disabled={!activeCall() || audioBusy()} aria-label={microphoneEnabled() ? "Mute microphone" : "Unmute microphone"} title={!activeCall() ? "Join a call to use your microphone" : microphoneEnabled() ? "Mute microphone" : "Unmute microphone"} aria-pressed={!microphoneEnabled()} onClick={() => void toggleMicrophone()}>
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/><Show when={!microphoneEnabled()}><path d="m3 3 18 18"/></Show></svg>
      </button>
      <button class="icon-btn self-audio-btn" classList={{ "is-off": deafened() }} type="button" disabled={audioBusy()} aria-label={deafened() ? "Undeafen" : "Deafen"} title={deafened() ? "Undeafen: restore call audio" : "Deafen: mute microphone and call audio"} aria-pressed={deafened()} onClick={() => void toggleDeafen()}>
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="12" width="4" height="8" rx="2"/><rect x="17" y="12" width="4" height="8" rx="2"/><Show when={deafened()}><path d="m3 3 18 18"/></Show></svg>
      </button>
      <button class="icon-btn self-nameplate-settings" type="button" title="Account" aria-label="Account" onClick={props.onAccount}><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 3-.6 2.1-1.6.9-2.1-.5-2.4 4.1 1.5 1.6v1.8l-1.5 1.6 2.4 4.1 2.1-.5 1.6.9.6 2.1h4.8l.6-2.1 1.6-.9 2.1.5 2.4-4.1-1.5-1.6v-1.8l1.5-1.6-2.4-4.1-2.1.5-1.6-.9-.6-2.1Z"/><circle cx="11.9" cy="12" r="3"/></svg></button>
    </div>
    <Show when={statusOpen()}><div ref={menu} class="self-status-menu" role="menu" aria-label="Your status" onKeyDown={event => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      event.preventDefault(); items[next]?.focus();
    }}><button type="button" class="self-note-open" onClick={openNote}><span aria-hidden="true">{props.note?.emoji || "✎"}</span><span>{props.note ? props.note.text || "Change your custom status" : "Set a custom status"}</span></button><p class="self-status-title">Set status</p><For each={AVAILABILITY_OPTIONS}>{option => <button type="button" role="menuitemradio" aria-checked={status() === option.id} disabled={statusBusy()} onClick={() => void chooseStatus(option.id)}><span class={`status-dot status-${option.id}`} aria-hidden="true"/><span><strong>{option.label}</strong><small>{option.hint}</small></span><Show when={status() === option.id}><span aria-hidden="true">✓</span></Show></button>}</For><Show when={statusError()}><p role="alert" class="self-status-error">{statusError()}</p></Show></div></Show>
    <Modal title="Set a custom status" open={noteOpen()} onClose={() => setNoteOpen(false)}>
      <form class="modal-form note-form" onSubmit={(event) => { event.preventDefault(); void saveMyNote(); }}>
        <p class="modal-text">Everyone sees it under your name while you are online.</p>
        <label class="field"><span>What are you up to?</span><input type="text" maxLength={80} placeholder="Editing a video" value={noteText()} onInput={(event) => setNoteText(event.currentTarget.value)} autofocus /></label>
        <div class="note-emojis" role="group" aria-label="Emoji"><For each={NOTE_EMOJIS}>{emoji => <button type="button" aria-pressed={noteEmoji() === emoji} title={emoji ? "Use this emoji" : "No emoji"} onClick={() => setNoteEmoji(emoji)}>{emoji || "—"}</button>}</For></div>
        <span class="group-label">Clear after</span>
        <div class="note-after" role="group" aria-label="Clear after"><For each={CLEAR_AFTER}>{([minutes, label]) => <button type="button" class="btn" aria-pressed={noteAfter() === minutes} onClick={() => setNoteAfter(minutes)}>{label}</button>}</For></div>
        <Show when={noteError()}><p class="form-error" role="alert">{noteError()}</p></Show>
        <div class="note-actions">
          <Show when={props.note}><button type="button" class="btn danger" disabled={noteBusy()} onClick={() => void saveMyNote(true)}>Clear status</button></Show>
          <span />
          <button type="button" class="btn" onClick={() => setNoteOpen(false)}>Cancel</button>
          <button type="submit" class="btn primary" disabled={noteBusy()}>{noteBusy() ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </Modal>
    <Show when={audioError() && !statusOpen()}><div class="self-audio-error" role="alert">{audioError()}</div></Show>
  </>;
}
