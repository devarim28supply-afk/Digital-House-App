import { Match, Show, Switch, createSignal, onMount } from "solid-js";

import { access } from "../firebase";

import "./auth.css";

type Mode = "login" | "register" | "forgot";
type Mood = "ready" | "typing" | "working" | "error";

const STATUS: Record<Mood, { label: string; colour: string }> = {
  ready: { label: "ready", colour: "#4ADE80" },
  typing: { label: "typing…", colour: "#A3A3A3" },
  working: { label: "authenticating…", colour: "#FBBF24" },
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
  let typingTimer = 0;
  let card: HTMLDivElement | undefined;

  function onInput() {
    if (mood() === "working") return;
    setMood("typing");
    window.clearTimeout(typingTimer);
    typingTimer = window.setTimeout(() => setMood("ready"), 1000);
  }

  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : "Something went wrong.");
    setMood("error");
    window.setTimeout(() => setMood("ready"), 1400);
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
    setMood("working");
    try {
      await access.login(String(form.get("id") ?? ""), String(form.get("password") ?? ""));
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
      await access.register({
        fullName: String(form.get("name") ?? ""),
        username: String(form.get("username") ?? ""),
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
      });
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
              <form class="auth-form" onSubmit={onLogin}>
                <label class="auth-field">
                  <span>Username or email</span>
                  <input name="id" autocomplete="username" autocapitalize="off" spellcheck={false} required />
                </label>
                <label class="auth-field">
                  <span>Password</span>
                  <input name="password" type="password" autocomplete="current-password" required />
                </label>
                <Show when={error()}>
                  <p class="auth-error">{error()}</p>
                </Show>
                <button class="auth-submit" type="submit" disabled={mood() === "working"}>
                  Log in
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
              <p class="auth-sub">The operator approves new members.</p>
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
                  <span>Email</span>
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
