import { type JSX, Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js";

import { access, auth } from "../firebase";
import { type DhMember, checkEmailVerified, createDhMember, loadDhMember, normalizeUsername, resendVerification } from "./dhAccount";

import "./auth.css";

type Step = "checking" | "verify" | "profile" | "ready";

/**
 * Shown for someone who has an account but no operator-approved record: an open sign-up member.
 * Verify the real email (Firebase sends the link), then they are in. The children are the app itself.
 */
export function DhGate(props: { children: (member: DhMember) => JSX.Element }) {
  const user = () => auth.currentUser;
  const [step, setStep] = createSignal<Step>("checking");
  const [member, setMember] = createSignal<DhMember | null>(null);
  const [message, setMessage] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let poll = 0;

  async function run() {
    const u = user();
    if (!u) return;
    try {
      if (!(await checkEmailVerified())) {
        setStep("verify");
        return;
      }
      const existing = await loadDhMember(u.uid);
      if (existing) {
        setMember(existing);
        setStep("ready");
        return;
      }
      try {
        setMember(await createDhMember());
        setStep("ready");
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "noprofile") setStep("profile");
        else {
          setMessage(err instanceof Error ? err.message : "Could not finish. Try again.");
          setStep("profile");
        }
      }
    } catch {
      setMessage("Could not reach the server. Check your connection.");
      setStep("verify");
    }
  }

  onMount(() => {
    void run();
    // the person clicks the link in their email, maybe on another device: look again every few seconds
    poll = window.setInterval(() => {
      if (step() === "verify") void run();
    }, 4000);
  });
  onCleanup(() => window.clearInterval(poll));

  async function resend() {
    setBusy(true);
    setMessage("");
    try {
      await resendVerification();
      setMessage("Sent again. Check your inbox and your spam folder.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not send it again.");
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile(event: SubmitEvent) {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    setBusy(true);
    setMessage("");
    try {
      setMember(await createDhMember({ name: String(form.get("name") ?? ""), username: String(form.get("username") ?? "") }));
      setStep("ready");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not save that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Switch>
      <Match when={step() === "ready" && member()}>{(m) => props.children(m())}</Match>
      <Match when={step() === "checking"}>{null}</Match>
      <Match when={step() === "verify"}>
        <main class="auth-page">
          <section class="auth-card">
            <header class="auth-bar">
              <span class="dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span class="prompt">
                <b>~/darkwood-node</b> $ verify
              </span>
              <span class="status" style={{ "--status-colour": "#FBBF24" }}>
                waiting…
              </span>
            </header>
            <div class="auth-body">
              <h1 class="auth-title">Check your email</h1>
              <p class="auth-note">
                We sent a link to <b>{user()?.email}</b>. Open it to confirm this is you. This page opens Darkwood Node by itself
                a few seconds after you do.
              </p>
              <Show when={message()}>
                <p class="auth-note">{message()}</p>
              </Show>
              <button class="auth-submit" type="button" disabled={busy()} onClick={() => void run()}>
                I opened the link
              </button>
              <div class="auth-links">
                <button type="button" disabled={busy()} onClick={() => void resend()}>
                  Send the email again
                </button>
                <button type="button" onClick={() => void access.logout()}>
                  Log out
                </button>
              </div>
            </div>
          </section>
        </main>
      </Match>
      <Match when={step() === "profile"}>
        <main class="auth-page">
          <section class="auth-card">
            <header class="auth-bar">
              <span class="dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span class="prompt">
                <b>~/darkwood-node</b> $ profile
              </span>
              <span class="status" style={{ "--status-colour": "#4ADE80" }}>
                verified
              </span>
            </header>
            <div class="auth-body">
              <h1 class="auth-title">Choose your name</h1>
              <form class="auth-form" onSubmit={saveProfile}>
                <label class="auth-field">
                  <span>Your name</span>
                  <input name="name" autocomplete="name" maxLength={60} value={user()?.displayName ?? ""} required />
                </label>
                <label class="auth-field">
                  <span>Username (3 to 24 letters, digits, _ . -)</span>
                  <input
                    name="username"
                    autocapitalize="off"
                    spellcheck={false}
                    maxLength={24}
                    value={normalizeUsername((user()?.email ?? "").split("@")[0])}
                    required
                  />
                </label>
                <Show when={message()}>
                  <p class="auth-error" role="alert">
                    {message()}
                  </p>
                </Show>
                <button class="auth-submit" type="submit" disabled={busy()}>
                  Continue
                </button>
              </form>
            </div>
          </section>
        </main>
      </Match>
    </Switch>
  );
}
