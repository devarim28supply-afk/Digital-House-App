import { For, type JSX, Match, Show, Switch, createEffect, createSignal } from "solid-js";

import { FaceUnlockSetting } from "../auth/FaceOffer";
import { desktopSupported, enableDesktopAlerts, prefs as alertPrefs, setPrefs as setAlertPrefs } from "../data/alerts";
import { ACCENTS, accent, mode, saveAccent, saveMode } from "../data/layoutTheme";
import { forgetDeviceSettings, setUserPrefs, userPrefs } from "../data/prefs";
import { AVAILABILITY_OPTIONS, type Availability, availabilityStatus } from "../data/status";
import { type Profile, saveAvailability } from "../data/store";
import { AccessibilityPage } from "./Accessibility";
import { DeveloperBadge } from "./DeveloperBadge";
import { Modal } from "./Modal";
import { faceStyle, faceText } from "./Shell";
import "./accessibility.css";
import "./settings.css";

/**
 * Settings (Kaalob: neat and clean, in the style of Discord's, with
 * Discord's sections): one window with its sections down the left and the
 * picked section's page on the right. On a phone the sections are a row of
 * tabs across the top.
 *
 *   User settings   My Account      who you are, Edit profile, your status
 *                   Privacy         whether others see where you are
 *   App settings    Appearance      dark or light, the color
 *                   Accessibility   text, zoom, contrast, motion (Accessibility.tsx)
 *                   Voice & Video   camera, microphone, mirror
 *                   Chat            the clock, the key that sends
 *                   Notifications   desktop alerts, the call ring
 *                   Keybinds        the keys the app answers to
 *                   Sidebars        slide, hover, or always there
 *                   Advanced        the app's style, forget this device's settings
 *                   Face unlock     on a phone only: it is for logging in on
 *                                   the phone, so a computer never shows it
 *   Log out         at the bottom, apart from the rest
 *
 * This window is about you and this app on this device, nothing else
 * (Kaalob). What belongs to a server (its name, icon, banner, invite code,
 * people) is in that server's own settings, the gear by the server's name.
 * Roles for the whole of Darkwood Node are in the Dashboard.
 *
 * What Discord has and this leaves out, because Darkwood Node has nothing
 * for it: Family Center, Authorized Apps, Devices, Connections, Clips,
 * billing, Language (the app is in English), Streamer Mode.
 */

type SidebarMode = "slide" | "pinned" | "hover";
type Page = "account" | "privacy" | "appearance" | "access" | "voice" | "chat" | "notifications" | "keys" | "sidebars" | "advanced" | "face";

// a phone or tablet: a touch screen with no mouse pointer
const ON_PHONE = matchMedia("(hover: none) and (pointer: coarse)").matches;

export function Settings(props: {
  open: boolean;
  onClose: () => void;
  uid: string;
  name: string;
  username: string;
  profile?: Profile;
  /** both sidebars' behavior when they are set the same; undefined when each side has its own */
  sidebarMode?: SidebarMode;
  onSidebarMode: (mode: SidebarMode) => void;
  /** open the profile editor (picture, banner, nameplate) */
  onProfile: () => void;
  onLogout: () => void;
}) {
  const [page, setPage] = createSignal<Page>("account");
  const [error, setError] = createSignal("");
  const close = () => {
    setPage("account");
    setError("");
    props.onClose();
  };

  const groups: { label: string; items: { id: Page; label: string }[] }[] = [
    {
      label: "User settings",
      items: [
        { id: "account", label: "My Account" },
        { id: "privacy", label: "Privacy" },
      ],
    },
    {
      label: "App settings",
      items: [
        { id: "appearance", label: "Appearance" },
        { id: "access", label: "Accessibility" },
        { id: "voice", label: "Voice & Video" },
        { id: "chat", label: "Chat" },
        { id: "notifications", label: "Notifications" },
        { id: "keys", label: "Keybinds" },
        { id: "sidebars", label: "Sidebars" },
        { id: "advanced", label: "Advanced" },
        ...(ON_PHONE ? [{ id: "face" as const, label: "Face unlock" }] : []),
      ],
    },
  ];
  const titleOf = (id: Page) => groups.flatMap((g) => g.items).find((i) => i.id === id)?.label ?? "";

  /** One setting on a page: its name, the control, and a line saying what it does. */
  const Row = (p: { label: string; hint?: string; children: JSX.Element }) => (
    <div class="set-row">
      <b>{p.label}</b>
      {p.children}
      <Show when={p.hint}>
        <small>{p.hint}</small>
      </Show>
    </div>
  );
  /** On or off. */
  const Toggle = (p: { label: string; hint: string; value: boolean; onChange: (on: boolean) => void }) => (
    <label class="access-toggle">
      <span>
        <b>{p.label}</b>
        <small>{p.hint}</small>
      </span>
      <input type="checkbox" checked={p.value} onChange={(e) => p.onChange(e.currentTarget.checked)} />
    </label>
  );
  const Pick = <T extends string>(p: { value: T; options: { value: T; label: string }[]; onPick: (value: T) => void }) => (
    <div class="access-choices">
      <For each={p.options}>
        {(o) => (
          <button type="button" aria-pressed={p.value === o.value} onClick={() => p.onPick(o.value)}>
            {o.label}
          </button>
        )}
      </For>
    </div>
  );

  // ---- My Account: your status ----
  const [status, setStatus] = createSignal<Availability>(availabilityStatus(props.profile?.availability));
  createEffect(() => setStatus(availabilityStatus(props.profile?.availability)));
  async function pickStatus(next: Availability) {
    const before = status();
    setStatus(next);
    setError("");
    try {
      await saveAvailability(props.uid, next);
    } catch {
      setStatus(before);
      setError("Could not change your status. Check your connection.");
    }
  }

  // ---- Voice & Video: this computer's cameras and microphones ----
  const [devices, setDevices] = createSignal<MediaDeviceInfo[]>([]);
  const [asking, setAsking] = createSignal(false);
  const listDevices = async () => setDevices(await navigator.mediaDevices.enumerateDevices().catch(() => []));
  // the browser hides the names until it has allowed a camera or microphone once
  const named = () => devices().some((d) => d.label);
  async function allowNames() {
    setAsking(true);
    setError("");
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      probe.getTracks().forEach((track) => track.stop());
    } catch {
      setError("The browser did not allow the camera or microphone, so their names stay hidden.");
    } finally {
      await listDevices();
      setAsking(false);
    }
  }
  createEffect(() => {
    if (props.open && page() === "voice") void listDevices();
  });
  const DevicePick = (p: { kind: MediaDeviceKind; value: string; onPick: (id: string) => void; word: string }) => {
    const list = () => devices().filter((d) => d.kind === p.kind && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications");
    return (
      <select class="set-select" value={list().some((d) => d.deviceId === p.value) ? p.value : ""} onChange={(e) => p.onPick(e.currentTarget.value)}>
        <option value="">The computer's default {p.word}</option>
        <For each={list()}>{(d, i) => <option value={d.deviceId}>{d.label || `${p.word[0].toUpperCase()}${p.word.slice(1)} ${i() + 1}`}</option>}</For>
      </select>
    );
  };

  // ---- Advanced ----
  const [noir, setNoir] = createSignal(document.documentElement.dataset.style === "noir");
  function pickNoir(on: boolean) {
    setNoir(on);
    try {
      localStorage.setItem("dh_style", on ? "noir" : "off");
    } catch {
      /* a private window: it lasts until the page is closed */
    }
    if (on) document.documentElement.dataset.style = "noir";
    else delete document.documentElement.dataset.style;
  }
  const [forgetArmed, setForgetArmed] = createSignal(false);
  function forget() {
    if (!forgetArmed()) return void setForgetArmed(true);
    forgetDeviceSettings();
    location.reload();
  }

  const keys: [string, string][] = [
    ["Enter", "Send your message (or Ctrl+Enter, if you chose that under Chat)"],
    ["Shift + Enter", "A new line in your message"],
    ["@", "Start typing a name to mention someone; ↑ ↓ pick, Enter or Tab puts it in"],
    ["Esc", "Close a dialog, a menu, the picture viewer, or full screen"],
    ["Double-click a tile", "Open that person or screen big; double-click again to go back"],
    ["Click a name on a tile", "Show that you are talking to that person"],
    ["Mouse at the screen's edge", "Bring a sidebar in"],
    ["Double-click a sidebar's edge", "Put the right sidebar back to its normal width"],
  ];

  return (
    <Modal title="Settings" class="settings" open={props.open} onClose={close}>
      <div class="set">
        <nav class="set-nav" aria-label="Settings sections">
          <For each={groups}>
            {(group) => (
              <>
                <span class="set-nav-label">{group.label}</span>
                <For each={group.items}>
                  {(item) => (
                    <button
                      type="button"
                      class="set-nav-item"
                      aria-current={page() === item.id ? "page" : undefined}
                      onClick={() => {
                        setError("");
                        setPage(item.id);
                      }}
                    >
                      {item.label}
                    </button>
                  )}
                </For>
              </>
            )}
          </For>
          <span class="set-nav-gap" aria-hidden="true" />
          <button type="button" class="set-nav-item danger" onClick={props.onLogout}>
            Log out
          </button>
        </nav>

        <section class="set-page" aria-label={titleOf(page())}>
          <h3 class="set-title">{titleOf(page())}</h3>
          <Show when={error()}>
            <p class="form-error">{error()}</p>
          </Show>
          <Switch>
            <Match when={page() === "account"}>
              {/* who you are signed in as, and the things that belong to the account */}
              <div class="set-card">
                <span class="avatar big" style={faceStyle(props.profile)}>
                  {faceText(props.profile, props.name)}
                </span>
                <div class="set-card-text">
                  <b>
                    {props.name}
                    <DeveloperBadge username={props.username} />
                  </b>
                  <small>@{props.username || "member"}</small>
                </div>
                <button class="btn primary" type="button" title="Your picture, banner, nameplate and the name people see" onClick={props.onProfile}>
                  Edit profile
                </button>
              </div>
              <Row label="Status" hint={AVAILABILITY_OPTIONS.find((o) => o.id === status())?.hint}>
                <div class="access-choices">
                  <For each={AVAILABILITY_OPTIONS}>
                    {(option) => (
                      <button type="button" aria-pressed={status() === option.id} onClick={() => void pickStatus(option.id)}>
                        <i class={`status-dot status-${option.id}`} aria-hidden="true" /> {option.label}
                      </button>
                    )}
                  </For>
                </div>
              </Row>
              <Row label="Username" hint="Your username is what you log in with. It cannot be changed here.">
                <code class="set-code">@{props.username || "member"}</code>
              </Row>
              <Row label="Log out" hint="You stay logged in on your other devices.">
                <div class="set-actions">
                  <button class="btn danger" type="button" onClick={props.onLogout}>
                    Log out
                  </button>
                </div>
              </Row>
            </Match>

            <Match when={page() === "privacy"}>
              <Toggle
                label="Show where I am"
                hint='On: the people list says which room or videochat you are in ("In Node Lounge"), and your picture shows on that room’s tile. Off: you still show as online, with no place.'
                value={userPrefs().shareWhere}
                onChange={(on) => setUserPrefs({ shareWhere: on })}
              />
              <p class="set-note">To show as offline altogether, set your status to Invisible under My Account.</p>
            </Match>

            <Match when={page() === "appearance"}>
              <Row label="Theme" hint="Webcams, TV screens and the 3D rooms stay dark in light mode. So does the login page.">
                <div class="set-themes">
                  <button type="button" class="set-theme dark" aria-pressed={mode() === "dark"} onClick={() => saveMode("dark")}>
                    <span class="set-theme-sample" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    Dark
                  </button>
                  <button type="button" class="set-theme light" aria-pressed={mode() === "light"} onClick={() => saveMode("light")}>
                    <span class="set-theme-sample" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    Light
                  </button>
                </div>
              </Row>
              <Row label="Color" hint="The same design in another color. The 3D rooms keep their own colors.">
                <div class="accent-pick">
                  <For each={ACCENTS}>
                    {(a) => (
                      <button type="button" class="accent-choice" style={{ "--swatch": a.color }} aria-pressed={accent() === a.id} onClick={() => saveAccent(a.id)}>
                        <i aria-hidden="true" />
                        {a.label}
                      </button>
                    )}
                  </For>
                </div>
              </Row>
              <p class="set-note">Both change right away and stay in this browser.</p>
            </Match>

            <Match when={page() === "access"}>
              <AccessibilityPage />
            </Match>

            <Match when={page() === "voice"}>
              <Row label="Camera" hint="The camera a call turns on. It is used from the next call you join.">
                <DevicePick kind="videoinput" word="camera" value={userPrefs().camDevice} onPick={(id) => setUserPrefs({ camDevice: id })} />
              </Row>
              <Row label="Microphone" hint="The microphone a call uses. It is used from the next call you join.">
                <DevicePick kind="audioinput" word="microphone" value={userPrefs().micDevice} onPick={(id) => setUserPrefs({ micDevice: id })} />
              </Row>
              <Show when={!named()}>
                <Row label="Device names" hint="The browser hides the names of your cameras and microphones until it has allowed them once.">
                  <div class="set-actions">
                    <button class="btn" type="button" disabled={asking()} onClick={() => void allowNames()}>
                      {asking() ? "Asking…" : "Show the names"}
                    </button>
                  </div>
                </Row>
              </Show>
              <Toggle
                label="Mirror my camera"
                hint="Your own tile shows you like a mirror, the way most people expect to see themselves. Other people always see you the right way round."
                value={userPrefs().mirrorCam}
                onChange={(on) => setUserPrefs({ mirrorCam: on })}
              />
            </Match>

            <Match when={page() === "chat"}>
              <Row label="Clock" hint="How times show beside messages.">
                <Pick
                  value={userPrefs().timeFormat}
                  options={[
                    { value: "auto", label: "Same as my computer" },
                    { value: "12", label: "12-hour (2:30 PM)" },
                    { value: "24", label: "24-hour (14:30)" },
                  ]}
                  onPick={(value) => setUserPrefs({ timeFormat: value })}
                />
              </Row>
              <Row label="Send a message with" hint="Enter: Shift+Enter makes a new line. Ctrl+Enter: Enter makes a new line, good for long messages.">
                <Pick
                  value={userPrefs().sendKey}
                  options={[
                    { value: "enter", label: "Enter" },
                    { value: "ctrl", label: "Ctrl + Enter" },
                  ]}
                  onPick={(value) => setUserPrefs({ sendKey: value })}
                />
              </Row>
              <p class="set-note">Text size, the space between messages, Cozy or Compact, moving pictures and the Send button are under Accessibility.</p>
            </Match>

            <Match when={page() === "notifications"}>
              <Show when={desktopSupported()} fallback={<p class="set-note">This browser has no desktop notifications.</p>}>
                <Toggle
                  label="Desktop notifications"
                  hint="When Darkwood Node is not the tab you are looking at, an incoming call or a message for you shows as a notification from the browser. The browser asks you to allow it the first time."
                  value={alertPrefs().desktop}
                  onChange={(on) => {
                    if (!on) return setAlertPrefs({ desktop: false });
                    void enableDesktopAlerts().then((ok) => {
                      if (!ok) setError("The browser did not allow notifications. Allow them for this site in the browser's own settings, then try again.");
                    });
                  }}
                />
              </Show>
              <Toggle label="Call ring sound" hint="A soft ring when someone calls, for people who can hear it. The popup, the flashing tab title and the phone buzz show either way." value={alertPrefs().ring} onChange={(on) => setAlertPrefs({ ring: on })} />
            </Match>

            <Match when={page() === "keys"}>
              <div class="set-keys">
                <For each={keys}>
                  {([key, does]) => (
                    <div class="set-key">
                      <kbd>{key}</kbd>
                      <span>{does}</span>
                    </div>
                  )}
                </For>
              </div>
              <p class="set-note">These are fixed for now; they cannot be changed.</p>
            </Match>

            <Match when={page() === "sidebars"}>
              <Row
                label="How the sidebars behave"
                hint="This sets the left and the right side at once. The pin on each sidebar then pins only that side. A touch screen keeps its own swipe and tap controls."
              >
                <div class="access-choices">
                  <button type="button" aria-pressed={props.sidebarMode === "slide"} onClick={() => props.onSidebarMode("slide")}>
                    Slide in and out
                  </button>
                  <button type="button" aria-pressed={props.sidebarMode === "hover"} onClick={() => props.onSidebarMode("hover")}>
                    Show only on hover
                  </button>
                  <button type="button" aria-pressed={props.sidebarMode === "pinned"} onClick={() => props.onSidebarMode("pinned")}>
                    Always show
                  </button>
                </div>
              </Row>
              <Show when={!props.sidebarMode}>
                <p class="set-note">Right now each side has its own setting (one is pinned, the other is not). Picking one above sets both.</p>
              </Show>
              <p class="set-note">
                Slide in and out: move the mouse to the edge of the screen and the sidebar comes in, then stays a few seconds. Show only on hover: it leaves as soon as the mouse does. The right sidebar's width is under Accessibility, Size.
              </p>
            </Match>

            <Match when={page() === "advanced"}>
              <Toggle label="Terminal Noir style" hint="The app's own look: the fine grid, the glow on what is active, sharper corners. Off shows the plain look underneath." value={noir()} onChange={pickNoir} />
              <Row
                label="Forget this device's settings"
                hint="Puts everything in Settings back to how the app comes, on this device only: theme, color, accessibility, sidebars, the TV, voice and chat choices. You stay logged in, and nothing in your account or any server changes. The page reloads."
              >
                <div class="set-actions">
                  <button class="btn danger" type="button" onClick={forget}>
                    {forgetArmed() ? "Click again to forget them" : "Forget settings on this device"}
                  </button>
                </div>
              </Row>
            </Match>

            <Match when={page() === "face"}>
              <FaceUnlockSetting />
            </Match>
          </Switch>
        </section>
      </div>
    </Modal>
  );
}
