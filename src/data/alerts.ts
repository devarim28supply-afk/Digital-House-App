import { createSignal } from "solid-js";

/*
 * Alerts you can SEE (no sound needed): a toast stack, a flashing tab title, a phone buzz, and, if you allow it,
 * a desktop notification when the tab is hidden. A soft ring tone plays only for incoming calls, for people who can hear it.
 */

export type Alert = { id: string; title: string; detail: string; at: number; onClick?: () => void };

const [alerts, setAlerts] = createSignal<Alert[]>([]);
export { alerts };

const timers = new Map<string, number>();
export function dismissAlert(id: string) {
  window.clearTimeout(timers.get(id));
  timers.delete(id);
  setAlerts((all) => all.filter((a) => a.id !== id));
}
/** A toast that goes away by itself after a few seconds. The same id replaces the old one. */
export function pushAlert(alert: Omit<Alert, "at">, ms = 7000) {
  dismissAlert(alert.id);
  setAlerts((all) => [...all, { ...alert, at: Date.now() }].slice(-4));
  timers.set(alert.id, window.setTimeout(() => dismissAlert(alert.id), ms));
}

// ---- preferences (this device) ----
const PREFS_KEY = "dh_alert_prefs";
type Prefs = { desktop: boolean; ring: boolean };
function loadPrefs(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return { desktop: v.desktop === true, ring: v.ring !== false };
  } catch {
    return { desktop: false, ring: true };
  }
}
const [prefs, setPrefsSignal] = createSignal<Prefs>(loadPrefs());
export { prefs };
export function setPrefs(patch: Partial<Prefs>) {
  const next = { ...prefs(), ...patch };
  setPrefsSignal(next);
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
}
export const desktopSupported = () => typeof Notification !== "undefined";
/** Ask the browser once; the answer is kept as the "desktop alerts" choice. */
export async function enableDesktopAlerts(): Promise<boolean> {
  if (!desktopSupported()) return false;
  const answer = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  setPrefs({ desktop: answer === "granted" });
  return answer === "granted";
}

/** A desktop notification, only when this tab is not the one you are looking at. */
export function desktopNotify(title: string, body: string, onClick?: () => void) {
  if (!prefs().desktop || !desktopSupported() || Notification.permission !== "granted" || document.visibilityState === "visible") return;
  try {
    const n = new Notification(title, { body, tag: title, icon: "/favicon.ico" });
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
  } catch {
    /* some phones only allow it from a service worker */
  }
}

export function buzz(pattern: number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not supported */
  }
}

// ---- the tab title flashes while something waits ----
const baseTitle = document.title;
let titleTimer = 0;
export function flashTitle(text: string | null) {
  window.clearInterval(titleTimer);
  titleTimer = 0;
  if (!text) {
    document.title = baseTitle;
    return;
  }
  let on = false;
  const tick = () => {
    on = !on;
    document.title = on ? text : baseTitle;
  };
  tick();
  titleTimer = window.setInterval(tick, 1000);
}

// ---- ring tone: two soft notes every 2.5 s, only while a call is ringing ----
let audio: AudioContext | undefined;
let ringTimer = 0;
function note(freq: number, start: number, length: number) {
  if (!audio) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, audio.currentTime + start);
  gain.gain.linearRampToValueAtTime(0.12, audio.currentTime + start + 0.03);
  gain.gain.linearRampToValueAtTime(0, audio.currentTime + start + length);
  osc.connect(gain).connect(audio.destination);
  osc.start(audio.currentTime + start);
  osc.stop(audio.currentTime + start + length + 0.05);
}
export function startRing() {
  if (ringTimer || !prefs().ring) return;
  const play = () => {
    try {
      audio ??= new AudioContext();
      void audio.resume();
      note(660, 0, 0.35);
      note(880, 0.4, 0.45);
    } catch {
      /* the browser has not allowed sound yet */
    }
  };
  play();
  ringTimer = window.setInterval(play, 2500);
}
export function stopRing() {
  window.clearInterval(ringTimer);
  ringTimer = 0;
}
