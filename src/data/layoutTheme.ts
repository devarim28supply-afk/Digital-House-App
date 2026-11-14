import { createSignal } from "solid-js";

export type LayoutTheme = "smoky" | "classic";
const STORAGE_KEY = "dh_layout_theme";
function readTheme(): LayoutTheme {
  try { return localStorage.getItem(STORAGE_KEY) === "smoky" ? "smoky" : "classic"; }
  catch { return "classic"; }
}
const [layoutTheme, updateTheme] = createSignal<LayoutTheme>(readTheme());
export { layoutTheme };
export function previewLayoutTheme(theme: LayoutTheme) {
  updateTheme(theme);
  // Terminal Noir is the look for everyone: while it is on, Smoky Glass does not take over the colours
  document.documentElement.dataset.layoutTheme = document.documentElement.dataset.style === "noir" ? "classic" : theme;
}
export function saveLayoutTheme(theme: LayoutTheme) {
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* Private browsing still supports the current session. */ }
  previewLayoutTheme(theme);
}
previewLayoutTheme(layoutTheme());
window.addEventListener("storage", event => {
  if (event.key === STORAGE_KEY) previewLayoutTheme(readTheme());
});
/**
 * The color theme: the same design, with another color where the green is
 * (Account > Color theme). Kept in this browser, like the layout theme.
 * layout-themes.css holds the colors, under :root[data-accent].
 */
export const ACCENTS = [
  { id: "green", label: "Green", color: "#4ade80" },
  { id: "blue", label: "Blue", color: "#5aa9ff" },
  { id: "orange", label: "Orange", color: "#fb923c" },
  { id: "red", label: "Red", color: "#ff5a5a" },
  { id: "purple", label: "Purple", color: "#b08cff" },
  { id: "pink", label: "Pink", color: "#f472b6" },
  { id: "yellow", label: "Yellow", color: "#fde047" },
  { id: "teal", label: "Teal", color: "#2dd4bf" },
] as const;
export type Accent = (typeof ACCENTS)[number]["id"];
const ACCENT_KEY = "dh_accent";
function readAccent(): Accent {
  try {
    const saved = localStorage.getItem(ACCENT_KEY);
    return ACCENTS.find((a) => a.id === saved)?.id ?? "green";
  } catch { return "green"; }
}
const [accent, updateAccent] = createSignal<Accent>(readAccent());
export { accent };
function showAccent(next: Accent) {
  updateAccent(next);
  document.documentElement.dataset.accent = next;
}
export function saveAccent(next: Accent) {
  try { localStorage.setItem(ACCENT_KEY, next); } catch { /* Private browsing still supports the current session. */ }
  showAccent(next);
}
showAccent(accent());
window.addEventListener("storage", event => {
  if (event.key === ACCENT_KEY) showAccent(readAccent());
});
/**
 * Dark mode (the app as it is) or light mode (Account > Appearance). Kept in
 * this browser. src/ui/light-mode.css holds the light colours, under
 * html[data-mode="light"].
 */
export type Mode = "dark" | "light";
const MODE_KEY = "dh_mode";
function readMode(): Mode {
  try { return localStorage.getItem(MODE_KEY) === "light" ? "light" : "dark"; }
  catch { return "dark"; }
}
const [mode, updateMode] = createSignal<Mode>(readMode());
export { mode };
function showMode(next: Mode) {
  updateMode(next);
  document.documentElement.dataset.mode = next;
}
export function saveMode(next: Mode) {
  try { localStorage.setItem(MODE_KEY, next); } catch { /* Private browsing still supports the current session. */ }
  showMode(next);
}
showMode(mode());
window.addEventListener("storage", event => {
  if (event.key === MODE_KEY) showMode(readMode());
});
function updateMotion() {
  document.documentElement.dataset.motionPaused = String(document.hidden);
}
document.addEventListener("visibilitychange", updateMotion);
updateMotion();
