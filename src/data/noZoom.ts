// Phones and tablets: the app stays exactly the size of the screen. No pinch zoom, no double-tap zoom.
// Chrome on Android obeys the viewport rule in index.html. iPhone Safari ignores it, so its own
// pinch gesture events are cancelled here, and a double tap is cancelled by touch-action in styles.css.
if (window.matchMedia("(pointer: coarse)").matches) {
  const stop = (event: Event) => event.preventDefault();
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, stop, { passive: false });
  }
  // two fingers on the screen are a pinch, not a tap or a drag: never let the browser take them
  document.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length > 1) event.preventDefault();
    },
    { passive: false },
  );
}
