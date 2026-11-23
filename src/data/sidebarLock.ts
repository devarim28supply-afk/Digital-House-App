import { createSignal } from "solid-js";

/**
 * Lock mode (as in the desktop app): the lock button under a videochat stops
 * the sidebars sliding in from the screen's edges, so the mouse can go to the
 * edge without anything covering the call. Click it again to let them slide.
 * Kept in this browser.
 */
const KEY = "dh_sidebars_locked";
const read = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};

const [sidebarsLocked, setNow] = createSignal(read());
export { sidebarsLocked };

export function setSidebarsLocked(on: boolean) {
  setNow(on);
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* a private window: it lasts for this visit */
  }
}

window.addEventListener("storage", (event) => {
  if (event.key === KEY) setNow(read());
});
