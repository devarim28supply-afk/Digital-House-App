import { createSignal } from "solid-js";

/**
 * Accessibility settings (Kaalob: the whole thing, like Discord's
 * Accessibility and Appearance pages). Kept in this browser. Each one is
 * shown to the page as a data-* switch or a CSS variable on <html>;
 * src/ui/accessibility.css holds what each one does.
 *
 * Every default is the app as it was: nothing changes until someone moves a
 * setting, and "Reset" puts it all back.
 */
export type Access = {
  /** chat text size in px (Discord: Chat font scaling, 12 to 24) */
  chatSize: number;
  /** space above each new group of messages in px (Discord: 0 to 24) */
  groupGap: number;
  /** the whole app bigger or smaller, in % (Discord: Zoom level, 50 to 200) */
  zoom: number;
  /** cozy: avatars, roomy. compact: no avatars, more messages fit */
  display: "cozy" | "compact";
  /** how strong the colors are, in % (Discord: Saturation) */
  saturation: number;
  /** stronger text and lines against the background */
  contrast: "normal" | "high";
  /** links are always underlined, not told apart by color alone */
  underlineLinks: boolean;
  /** movement in the app: as the computer says, less, or all of it */
  motion: "auto" | "reduce" | "full";
  /** GIFs, animated emojis and stickers in chat: play, play under the pointer, or stay still */
  animations: "always" | "hover" | "never";
  /** the Send button next to the message box (Enter always sends) */
  sendButton: boolean;
  /** the left sidebar's width in px, 0 = its normal width (drag its edge) */
  leftWidth: number;
  /** the right sidebar's width in px, 0 = its normal width (drag its edge) */
  rightWidth: number;
};

export const ACCESS_DEFAULTS: Access = {
  chatSize: 15,
  groupGap: 6,
  zoom: 100,
  display: "cozy",
  saturation: 100,
  contrast: "normal",
  underlineLinks: false,
  motion: "auto",
  animations: "always",
  sendButton: true,
  leftWidth: 0,
  rightWidth: 0,
};

/** The app is drawn this much bigger on a computer to begin with (app.css); Zoom level multiplies it. */
export const BASE_ZOOM = 1.15;
export const LEFT_WIDTH = { min: 200, max: 460, normal: 248 };
export const RIGHT_WIDTH = { min: 260, max: 900 };

const KEY = "dh_access";
const clamp = (n: unknown, min: number, max: number, fallback: number) => {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, v));
};
const oneOf = <T extends string>(v: unknown, all: readonly T[], fallback: T): T => (all.includes(v as T) ? (v as T) : fallback);

/** Whatever was saved, made safe: unknown or out-of-range values fall back to the default. */
function clean(raw: Partial<Access> | null | undefined): Access {
  const d = ACCESS_DEFAULTS;
  const r = raw ?? {};
  return {
    chatSize: clamp(r.chatSize, 12, 24, d.chatSize),
    groupGap: clamp(r.groupGap, 0, 24, d.groupGap),
    zoom: clamp(r.zoom, 50, 200, d.zoom),
    display: oneOf(r.display, ["cozy", "compact"] as const, d.display),
    saturation: clamp(r.saturation, 0, 100, d.saturation),
    contrast: oneOf(r.contrast, ["normal", "high"] as const, d.contrast),
    underlineLinks: typeof r.underlineLinks === "boolean" ? r.underlineLinks : d.underlineLinks,
    motion: oneOf(r.motion, ["auto", "reduce", "full"] as const, d.motion),
    animations: oneOf(r.animations, ["always", "hover", "never"] as const, d.animations),
    sendButton: typeof r.sendButton === "boolean" ? r.sendButton : d.sendButton,
    leftWidth: r.leftWidth ? clamp(r.leftWidth, LEFT_WIDTH.min, LEFT_WIDTH.max, 0) : 0,
    rightWidth: r.rightWidth ? clamp(r.rightWidth, RIGHT_WIDTH.min, RIGHT_WIDTH.max, 0) : 0,
  };
}
function read(): Access {
  try {
    return clean(JSON.parse(localStorage.getItem(KEY) || "null") as Partial<Access> | null);
  } catch {
    return { ...ACCESS_DEFAULTS };
  }
}

const [access, setAccessNow] = createSignal<Access>(read());
export { access };

const lessMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/** Show the settings to the page: a switch or a variable on <html> for each one that is not at its default. */
function show(a: Access) {
  const root = document.documentElement;
  const d = ACCESS_DEFAULTS;
  const flag = (name: string, value: string | undefined) => {
    if (value === undefined) delete root.dataset[name];
    else root.dataset[name] = value;
  };
  const variable = (name: string, value: string | undefined) => {
    if (value === undefined) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  };
  flag("chatSize", a.chatSize !== d.chatSize ? "set" : undefined);
  variable("--chat-size", a.chatSize !== d.chatSize ? `${a.chatSize}px` : undefined);
  flag("groupGap", a.groupGap !== d.groupGap ? "set" : undefined);
  variable("--group-gap", a.groupGap !== d.groupGap ? `${a.groupGap}px` : undefined);
  variable("--app-zoom", a.zoom !== d.zoom ? String(Math.round(BASE_ZOOM * a.zoom) / 100) : undefined);
  flag("msg", a.display === "compact" ? "compact" : undefined);
  flag("sat", a.saturation !== d.saturation ? "set" : undefined);
  variable("--sat", a.saturation !== d.saturation ? String(a.saturation / 100) : undefined);
  flag("contrast", a.contrast === "high" ? "high" : undefined);
  flag("links", a.underlineLinks ? "underline" : undefined);
  const reduce = a.motion === "reduce" || (a.motion === "auto" && lessMotion.matches);
  flag("motion", reduce ? "reduce" : undefined);
  flag("gifs", a.animations !== "always" ? a.animations : undefined);
  flag("send", a.sendButton ? undefined : "off");
}

/** Change some settings: shown at once, and kept. */
export function setAccess(patch: Partial<Access>) {
  const next = clean({ ...access(), ...patch });
  setAccessNow(next);
  show(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* a private window: it lasts for this visit */
  }
}
/** Everything back to how the app comes. keepSizes: the sidebar widths stay. */
export function resetAccess(keepSizes = false) {
  const a = access();
  setAccess({ ...ACCESS_DEFAULTS, ...(keepSizes ? { leftWidth: a.leftWidth, rightWidth: a.rightWidth } : {}) });
}

show(access());
// the computer's own "less motion" setting changed while the app is open
lessMotion.addEventListener("change", () => show(access()));
// another tab of the app changed a setting
window.addEventListener("storage", (event) => {
  if (event.key !== KEY) return;
  const next = read();
  setAccessNow(next);
  show(next);
});
