import { saveLayoutTheme } from "../data/layoutTheme";
import { browserLocalPersistence, browserSessionPersistence, setPersistence } from "firebase/auth";
import { Match, Show, Switch, createSignal, onMount } from "solid-js";

import { access, auth } from "../firebase";
import { registerDhAccount } from "./dhAccount";
import { disableFaceUnlock, faceOfferDismissed, faceUnlockEnabled, faceUnlockSupported, holdLoginForOffer, unlockWithFace } from "./faceUnlock";

import "./auth.css";

type Mode = "login" | "register" | "forgot";
type Mood = "ready" | "typing" | "working" | "face" | "error";

const STATUS: Record<Mood, { label: string; colour: string }> = {
  ready: { label: "ready", colour: "#4ADE80" },
  typing: { label: "typing…", colour: "#A3A3A3" },
  working: { label: "authenticating…", colour: "#FBBF24" },
  face: { label: "checking…", colour: "#FBBF24" },
  error: { label: "error", colour: "#F87171" },
};

/**
 * The front door: Firebase login against the shared members registry.
 * Registering files a pending request; the operator approves it.
 */
export function Login() {
  const [mode, setMode] = createSignal<Mode>("login");
  const [mood, setMood] = createSignal<Mood>("ready");
  const [error, setError] = createSignal("");
  const [remember, setRemember] = createSignal(true);
  const [showPw, setShowPw] = createSignal(false);
  /** which fields to outline red after a failed try: "password", "both" or "" */
  const [bad, setBad] = createSignal<"" | "password" | "both">("");
  const [faceReady, setFaceReady] = createSignal(false);
  let typingTimer = 0;
  // the face button shows only on a phone that can do it AND has it switched on
  onMount(() => {
    if (faceUnlockEnabled()) void faceUnlockSupported().then((ok) => setFaceReady(ok));
  });
  let card: HTMLDivElement | undefined;

  function onInput() {
    if (mood() === "working") return;
    setMood("typing");
    window.clearTimeout(typingTimer);
    typingTimer = window.setTimeout(() => setMood("ready"), 1000);
  }

  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : "Something went wrong.");
    const code = (err as { code?: string } | null)?.code;
    setBad(code === "badlogin" ? "password" : code === "missing" ? "both" : "");
    window.setTimeout(() => setBad(""), 2500);
    try {
      navigator.vibrate?.([120, 60, 120]); // Android only; iPhone ignores it. The red field and message do the job everywhere.
    } catch {
      /* no vibration here */
    }
    setMood("error");
    window.setTimeout(() => setMood("ready"), 1400);
  }

  async function signIn(id: string, password: string) {
    // "stay signed in" off: the login lasts until the browser is closed
    await setPersistence(auth, remember() ? browserLocalPersistence : browserSessionPersistence).catch(() => undefined);
    await access.login(id, password);
  }

  async function onFace() {
    if (mood() === "working" || mood() === "face") return;
    setError("");
    setBad("");
    setMood("face");
    try {
      const saved = await unlockWithFace();
      setMood("working");
      await signIn(saved.id, saved.password);
      setMood("ready");
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "badlogin") {
        // the password changed since face unlock was set up: forget it, ask for the new one
        disableFaceUnlock();
        setFaceReady(false);
        fail(new Error("Your password changed. Log in with your new password to set up face unlock again."));
        return;
      }
      const cancelled = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError");
      fail(new Error(cancelled ? "Face not recognised. Try again, or log in with your password." : err instanceof Error ? err.message : "Face unlock failed."));
    }
  }

  // Every glitch layer on one clock, so the whole card hits at once.
  function syncGlitches() {
    for (const a of document.getAnimations()) {
      if (a instanceof CSSAnimation && /^auth\w*Glitch$/.test(a.animationName)) a.startTime = 0;
    }
  }
  onMount(() => requestAnimationFrame(syncGlitches));

  function go(next: Mode) {
    setError("");
    setMode(next);
    requestAnimationFrame(syncGlitches);
    card?.querySelector("input")?.focus();
  }

  async function onLogin(event: SubmitEvent) {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    setError("");
    setBad("");
    setMood("working");
    try {
      const id = String(form.get("id") ?? "");
      const password = String(form.get("password") ?? "");
      await signIn(id, password);
      // after the login the app asks once whether to turn on face unlock (FaceOffer), using this login
      if (!faceUnlockEnabled() && !faceOfferDismissed() && (await faceUnlockSupported())) holdLoginForOffer(id, password);
      setMood("ready");
    } catch (err) {
      fail(err);
    }
  }

  async function onRegister(event: SubmitEvent) {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    setError("");
    setMood("working");
    try {
      await registerDhAccount({
        name: String(form.get("name") ?? ""),
        username: String(form.get("username") ?? ""),
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
      });
      saveLayoutTheme("classic");
      setMood("ready");
    } catch (err) {
      fail(err);
    }
  }

  return (
    <main class="auth-page">
      <section class="auth-card" ref={card}>
        <header class="auth-bar">
          <span class="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span class="prompt">
            <b>~/darkwood-node</b> $ auth
          </span>
          <span class="status" role="status" style={{ "--status-colour": STATUS[mood()].colour }}>
            {STATUS[mood()].label}
          </span>
        </header>

        <div class="auth-body" onInput={onInput}>
          <Switch>
            <Match when={mode() === "login"}>
              <h1 class="auth-title">Log in</h1>
              <Show when={faceReady()}>
                <button class="auth-face" type="button" disabled={mood() === "working" || mood() === "face"} onClick={() => void onFace()}>
                  <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                    <path d="M4 11V7a3 3 0 0 1 3-3h4M21 4h4a3 3 0 0 1 3 3v4M28 21v4a3 3 0 0 1-3 3h-4M11 28H7a3 3 0 0 1-3-3v-4" />
                    <path d="M12 13v2M20 13v2M16 13v5h-1.5M12 21.5c2.4 2 5.6 2 8 0" />
                  </svg>
                  {mood() === "face" ? "Look at your phone…" : error() && mood() !== "working" ? "Try face again" : "Unlock with face"}
                </button>
                <p class="auth-or">or use password</p>
              </Show>
              <form class="auth-form" onSubmit={onLogin}>
                <label class="auth-field">
                  <span>Username or email</span>
                  <input name="id" autocomplete="username" autocapitalize="off" spellcheck={false} enterkeyhint="next" required />
                </label>
                <label class="auth-field">
                  <span>Password</span>
                  <span class="auth-pw" classList={{ bad: bad() !== "" }}>
                    <input name="password" type={showPw() ? "text" : "password"} autocomplete="current-password" enterkeyhint="go" required />
                    <button type="button" class="auth-show" aria-pressed={showPw()} onClick={() => setShowPw(!showPw())}>
                      {showPw() ? "Hide" : "Show"}
                    </button>
                  </span>
                </label>
                <label class="auth-remember">
                  <input type="checkbox" name="remember" checked={remember()} onChange={(e) => setRemember(e.currentTarget.checked)} />
                  <i aria-hidden="true" />
                  Stay signed in on this phone
                </label>
                <Show when={error()}>
                  <p class="auth-error" role="alert">{error()}</p>
                </Show>
                <button class="auth-submit" type="submit" disabled={mood() === "working" || mood() === "face"}>
                  {mood() === "working" ? "Logging in…" : "Log in"}
                </button>
              </form>
              <div class="auth-links">
                <button type="button" onClick={() => go("forgot")}>
                  Forgot password?
                </button>
                <button type="button" onClick={() => go("register")}>
                  Create account
                </button>
              </div>
            </Match>

            <Match when={mode() === "register"}>
              <h1 class="auth-title">Create account</h1>
              <p class="auth-sub">Use your real email. We send a link to confirm it, then you are in.</p>
              <form class="auth-form" onSubmit={onRegister}>
                <label class="auth-field">
                  <span>Full name</span>
                  <input name="name" autocomplete="name" maxLength={60} required />
                </label>
                <label class="auth-field">
                  <span>Username</span>
                  <input name="username" autocapitalize="off" spellcheck={false} maxLength={24} required />
                </label>
                <label class="auth-field">
                  <span>Real email</span>
                  <input name="email" type="email" autocomplete="email" required />
                </label>
                <label class="auth-field">
                  <span>Password (6+ characters)</span>
                  <input name="password" type="password" autocomplete="new-password" minLength={6} required />
                </label>
                <Show when={error()}>
                  <p class="auth-error">{error()}</p>
                </Show>
                <button class="auth-submit" type="submit" disabled={mood() === "working"}>
                  Create account
                </button>
              </form>
              <div class="auth-links">
                <button type="button" onClick={() => go("login")}>
                  ‹ Back to log in
                </button>
              </div>
            </Match>

            <Match when={mode() === "forgot"}>
              <h1 class="auth-title">Forgot password</h1>
              <p class="auth-note">
                Accounts here log in with a username, so there is no reset email. Ask the operator to reset your
                password, then log in with the new one.
              </p>
              <div class="auth-links">
                <button type="button" onClick={() => go("login")}>
                  ‹ Back to log in
                </button>
              </div>
            </Match>
          </Switch>
        </div>
      </section>
    </main>
  );
}
