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
    root.style.setProperty("--mobile-viewport-height",`${viewport?.height ?? window.innerHeight}px`);
    root.style.setProperty("--mobile-viewport-top",`${viewport?.offsetTop ?? 0}px`);
    root.dataset.mobileKeyboard = String(window.innerHeight - (viewport?.height ?? window.innerHeight) > 100);
  });
}
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
