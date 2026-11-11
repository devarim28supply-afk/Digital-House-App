import { Show, createSignal, onMount } from "solid-js";

import { disableFaceUnlock, dismissFaceOffer, enableFaceUnlock, faceUnlockEnabled, faceUnlockSupported, resetFaceOffer, takePendingLogin } from "./faceUnlock";
import "./auth.css";

/**
 * Shown once, right after a password login on a phone that can do face unlock.
 * Uses the login the Login screen just held; nothing is kept if you say "Not now".
 */
export function FaceOffer() {
  const login = takePendingLogin();
  const [open, setOpen] = createSignal(Boolean(login));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  let yes: HTMLButtonElement | undefined;
  onMount(() => yes?.focus());

  async function turnOn() {
    if (!login) return;
    setBusy(true);
    setError("");
    try {
      await enableFaceUnlock(login.id, login.password);
      setOpen(false);
    } catch (err) {
      const cancelled = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError");
      setError(cancelled ? "Face check was cancelled. Nothing was saved." : err instanceof Error ? err.message : "Could not turn on face unlock.");
    } finally {
      setBusy(false);
    }
  }
  function notNow() {
    dismissFaceOffer();
    setOpen(false);
  }

  return (
    <Show when={open()}>
      <section class="face-offer" role="dialog" aria-label="Face unlock">
        <h2>Turn on face unlock on this phone?</h2>
        <p>Next time, one look logs you in. Your face stays on the phone. You can turn it off in Account.</p>
        <Show when={error()}>
          <p class="err" role="alert">{error()}</p>
        </Show>
        <button ref={yes} class="yes" type="button" disabled={busy()} onClick={() => void turnOn()}>
          {busy() ? "Checking…" : "Turn on face unlock"}
        </button>
        <button class="no" type="button" disabled={busy()} onClick={notNow}>
          Not now
        </button>
      </section>
    </Show>
  );
}

/** Account dialog row: shows whether face unlock is on for this phone and turns it off. */
export function FaceUnlockSetting() {
  const [supported, setSupported] = createSignal(false);
  const [on, setOn] = createSignal(faceUnlockEnabled());
  onMount(() => void faceUnlockSupported().then(setSupported));
  return (
    <Show when={supported()}>
      <fieldset class="field">
        <legend>Face unlock · this phone</legend>
        <Show
          when={on()}
          fallback={<small class="call-name-note">Off. Log out and log in with your password to be asked again.</small>}
        >
          <small class="call-name-note">On. The login screen has an "Unlock with face" button.</small>
          <button
            class="btn"
            type="button"
            onClick={() => {
              disableFaceUnlock();
              resetFaceOffer();
              setOn(false);
            }}
          >
            Turn off face unlock
          </button>
        </Show>
      </fieldset>
    </Show>
  );
}
