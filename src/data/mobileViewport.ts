// Mobile keyboards can shrink only the visual viewport, leaving fixed panels behind.
const mobile = window.matchMedia("(max-width: 600px)");
const viewport = window.visualViewport;
let frame = 0;
function update() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    const root = document.documentElement;
    if (!mobile.matches) {
      root.style.removeProperty("--mobile-viewport-height");
      root.style.removeProperty("--mobile-viewport-top");
      delete root.dataset.mobileKeyboard;
      return;
    }
    // Don't reflow the interface during pinch zoom.
    if (viewport && Math.abs(viewport.scale - 1) > 0.05) return;
    const height=`${Math.round(viewport?.height ?? window.innerHeight)}px`;
    if(root.style.getPropertyValue("--mobile-viewport-height") !== height) root.style.setProperty("--mobile-viewport-height",height);
    const top=`${Math.round(viewport?.offsetTop ?? 0)}px`;
    if(root.style.getPropertyValue("--mobile-viewport-top") !== top) root.style.setProperty("--mobile-viewport-top",top);
    root.dataset.mobileKeyboard = String(window.innerHeight - (viewport?.height ?? window.innerHeight) > 100);
  });
}
// ---- turning the phone (Kaalob: no weird transition when it goes sideways or back upright) ----
// When a phone turns, the screen changes shape in one step, and everything
// in the app is laid out again for the new shape. Many parts normally glide
// to a new place (the call's pictures, the sidebars, the page beside them,
// the call's header and buttons): good for a tap, wrong for a turn, where
// they would all slide across a screen that has already turned. So while the
// screen is changing shape, nothing glides: every part is simply in its new
// place (html[data-turning], mobile-layout.css). Touch screens only; a
// computer window being dragged to a new size is left as it is.
//
// The turn itself is hidden (Kaalob: fade to black while it turns, fade back
// in when it is fully turned and set). The screen goes black the moment the
// turn is seen, stays black while the browser turns and the app lays itself
// out again, and fades back in once nothing has changed shape for a moment
// (html[data-blackout], mobile-layout.css). A browser only says a turn
// happened after it has begun, so the black comes on at once, not as a fade.
// Only a real turn does this: the keyboard opening also changes the screen's
// height, but not which way it is longer, so it is left alone.
const touch = window.matchMedia("(pointer: coarse)");
const sideways = () => window.innerWidth > window.innerHeight;
let wasSideways = sideways();
let turnTimer = 0;
let blackTimer = 0;
let blackSince = 0;
/** how long nothing may change shape before the picture comes back, and the longest it stays black */
const SETTLE_MS = 450;
const BLACK_MAX_MS = 1800;
function black() {
  const root = document.documentElement;
  if (!root.dataset.blackout) blackSince = Date.now();
  root.dataset.blackout = "1";
  window.clearTimeout(blackTimer);
  const left = Math.max(0, BLACK_MAX_MS - (Date.now() - blackSince));
  blackTimer = window.setTimeout(() => delete root.dataset.blackout, Math.min(SETTLE_MS, left));
}
function turning(event?: Event) {
  if (!touch.matches) return;
  document.documentElement.dataset.turning = "1";
  window.clearTimeout(turnTimer);
  // long enough for the browser's own turn and the layout that follows it
  turnTimer = window.setTimeout(() => delete document.documentElement.dataset.turning, 500);
  const now = sideways();
  // turned (it is now longer the other way), or still settling after a turn
  if (now !== wasSideways || event?.type !== "resize" || document.documentElement.dataset.blackout) black();
  wasSideways = now;
}
window.addEventListener("resize", turning);
window.addEventListener("orientationchange", turning);
screen.orientation?.addEventListener?.("change", turning);
viewport?.addEventListener("resize",update);
viewport?.addEventListener("scroll",update);
window.addEventListener("resize",update);
mobile.addEventListener("change",update);
update();
if (import.meta.hot) import.meta.hot.dispose(() => {
  cancelAnimationFrame(frame);
  viewport?.removeEventListener("resize",update);
  viewport?.removeEventListener("scroll",update);
  window.removeEventListener("resize",update);
  mobile.removeEventListener("change",update);
});
