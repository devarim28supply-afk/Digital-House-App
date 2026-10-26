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
  document.documentElement.dataset.layoutTheme = theme;
}
export function saveLayoutTheme(theme: LayoutTheme) {
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* Private browsing still supports the current session. */ }
  previewLayoutTheme(theme);
}
previewLayoutTheme(layoutTheme());
window.addEventListener("storage", event => {
  if (event.key === STORAGE_KEY) previewLayoutTheme(readTheme());
});
function updateMotion() {
  document.documentElement.dataset.motionPaused = String(document.hidden);
}
document.addEventListener("visibilitychange", updateMotion);
updateMotion();
