// Visual style of the app (colours, type, corners, glow only; never layout).
// Open the app with ?style=noir to try Terminal Noir on this browser, ?style=off to go back to the plain look.
const KEY = "dh_style";
try {
  const asked = new URLSearchParams(location.search).get("style");
  if (asked === "off") localStorage.removeItem(KEY);
  else if (asked) localStorage.setItem(KEY, asked);
  const chosen = localStorage.getItem(KEY);
  if (chosen === "noir") document.documentElement.dataset.style = "noir";
} catch {
  /* private window: the plain look */
}
