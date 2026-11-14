import { createSignal } from "solid-js";

/**
 * Your own settings for this app on this device (Settings.tsx): the ones
 * that are not about how things look (data/layoutTheme.ts) and not
 * accessibility (data/access.ts). Kept in this browser. Every default is the
 * app as it was.
 */
export type Prefs = {
  /** others see where you are ("In Node Lounge", "Videochat · Living Room") in the people list */
  shareWhere: boolean;
  /** the clock in chat: as the computer has it, 12-hour, or 24-hour */
  timeFormat: "auto" | "12" | "24";
  /** what sends a message: Enter (Shift+Enter for a new line), or Ctrl+Enter (Enter for a new line) */
  sendKey: "enter" | "ctrl";
  /** your own camera looks like a mirror on your own tile (others always see you the right way round) */
  mirrorCam: boolean;
  /** the camera and the microphone a call uses: a device's id, or "" for the computer's default */
  camDevice: string;
  micDevice: string;
};

export const PREF_DEFAULTS: Prefs = { shareWhere: true, timeFormat: "auto", sendKey: "enter", mirrorCam: true, camDevice: "", micDevice: "" };

const KEY = "dh_prefs";
function read(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Prefs>;
    return {
      shareWhere: v.shareWhere !== false,
      timeFormat: v.timeFormat === "12" || v.timeFormat === "24" ? v.timeFormat : "auto",
      sendKey: v.sendKey === "ctrl" ? "ctrl" : "enter",
      mirrorCam: v.mirrorCam !== false,
      camDevice: typeof v.camDevice === "string" ? v.camDevice : "",
      micDevice: typeof v.micDevice === "string" ? v.micDevice : "",
    };
  } catch {
    return { ...PREF_DEFAULTS };
  }
}

const [userPrefs, setNow] = createSignal<Prefs>(read());
export { userPrefs };

export function setUserPrefs(patch: Partial<Prefs>) {
  const next = { ...userPrefs(), ...patch };
  setNow(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* a private window: it lasts for this visit */
  }
}

/** The chat clock's 12 or 24 hour choice, for toLocaleTimeString. Nothing set: as the computer has it. */
export const hourCycle = (): { hour12?: boolean } => (userPrefs().timeFormat === "auto" ? {} : { hour12: userPrefs().timeFormat === "12" });

window.addEventListener("storage", (event) => {
  if (event.key === KEY) setNow(read());
});

/**
 * Everything this app keeps in this browser for how it looks and behaves,
 * forgotten (Settings > Advanced). You stay logged in, and face unlock and
 * what you have read are left alone.
 */
export function forgetDeviceSettings() {
  const keep = (key: string) => key.startsWith("dh_face_unlock") || key === "dh_dm_read" || key.startsWith("dh_notification_tabs_") || key === "dh_activity_seen" || key === "dh_last_server" || key.startsWith("dh_last_channel_");
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith("dh_") && !keep(key)) localStorage.removeItem(key);
  } catch {
    /* nothing kept to forget */
  }
}
