import { createEffect, createRoot, createSignal } from "solid-js";

/**
 * How your videochat looks on your own screen only (Settings > Appearance), as
 * in the desktop app: what is behind the tiles (the grid, one color or your own
 * picture; the same shows, darker, behind the channel's name) and your own
 * colors for the buttons under it. Kept in this browser.
 */
export type CallLook = {
  /** behind the tiles: "grid" is the app as it comes */
  kind: "grid" | "color" | "picture";
  color: string;
  /** your picture, made smaller and kept as a data: address ("" for none) */
  picture: string;
  /** Node Lounge's featured background (GTA6), in its videochat only: "" = not answered yet */
  featured: "on" | "off" | "";
  /** the buttons' colors, "" for the usual one: the button, its icon, the glow of a button that is on, Disconnect */
  button: string;
  icon: string;
  glow: string;
  leave: string;
};

const BG = "dh_call_bg";
const PICTURE = "dh_call_bg_picture";
const DOCK = "dh_call_dock";
const FEATURED = "dh_featured_bg";
/** Node Lounge's featured background picture */
export const FEATURED_PICTURE = `${import.meta.env.BASE_URL}featured/gta6.jpg`;
/** the same picture made smaller (1280x800) for touch screens: a tablet's browser ran out of
    room drawing the big one behind five videos and blinked, with black tiles, in landscape */
export const FEATURED_PICTURE_SMALL = `${import.meta.env.BASE_URL}featured/gta6-1280.jpg`;
/** the picture behind the videochat: the small one on touch screens */
export const featuredCallPicture = () =>
  typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches ? FEATURED_PICTURE_SMALL : FEATURED_PICTURE;
const hex = (v: unknown) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : "");

function read(): CallLook {
  let bg: Record<string, unknown> = {};
  let dock: Record<string, unknown> = {};
  let picture = "";
  let featured: string | null = "";
  try {
    bg = JSON.parse(localStorage.getItem(BG) || "{}") ?? {};
    dock = JSON.parse(localStorage.getItem(DOCK) || "{}") ?? {};
    picture = localStorage.getItem(PICTURE) || "";
    featured = localStorage.getItem(FEATURED);
  } catch {
    /* nothing kept */
  }
  if (!picture.startsWith("data:image/")) picture = "";
  return {
    kind: bg.kind === "color" || bg.kind === "picture" ? bg.kind : "grid",
    color: hex(bg.color) || "#101418",
    picture,
    featured: featured === "on" || featured === "off" ? featured : "",
    button: hex(dock.button),
    icon: hex(dock.icon),
    glow: hex(dock.glow),
    leave: hex(dock.leave),
  };
}

const [callLook, setNow] = createSignal<CallLook>(read());
export { callLook };

/** Your own background is on (a color, or a picture that is there). */
export const ownCallBackground = () => callLook().kind === "color" || (callLook().kind === "picture" && Boolean(callLook().picture));

export function setCallLook(patch: Partial<CallLook>) {
  const next = { ...callLook(), ...patch };
  setNow(next);
  try {
    if (patch.featured !== undefined) localStorage.setItem(FEATURED, next.featured);
    localStorage.setItem(BG, JSON.stringify({ kind: next.kind, color: next.color }));
    localStorage.setItem(DOCK, JSON.stringify({ button: next.button, icon: next.icon, glow: next.glow, leave: next.leave }));
    if (patch.picture !== undefined) {
      if (next.picture) localStorage.setItem(PICTURE, next.picture);
      else localStorage.removeItem(PICTURE);
    }
  } catch {
    /* a private window, or the picture is too big to keep: it lasts for this visit */
  }
}

/**
 * Your own picture for behind the videochat: made no bigger than a screen needs
 * and kept in this browser, so the file itself may be moved or deleted after.
 */
export async function pictureForCall(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1920 / bitmap.width, 1920 / bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

// the look goes onto the page as CSS variables and marks (ui/call-look.css reads them)
createRoot(() => {
  createEffect(() => {
    const look = callLook();
    const root = document.documentElement;
    const own = ownCallBackground();
    root.style.setProperty("--call-bg-color", own && look.kind === "color" ? look.color : "transparent");
    root.style.setProperty("--call-bg-image", own && look.kind === "picture" ? `url("${look.picture}")` : "none");
    for (const part of ["button", "icon", "glow", "leave"] as const) {
      if (look[part]) {
        root.style.setProperty(`--dock-${part}`, look[part]);
        root.setAttribute(`data-dock-${part}`, "");
      } else {
        root.style.removeProperty(`--dock-${part}`);
        root.removeAttribute(`data-dock-${part}`);
      }
    }
  });
});

window.addEventListener("storage", (event) => {
  if (event.key === BG || event.key === DOCK || event.key === PICTURE || event.key === FEATURED) setNow(read());
});
