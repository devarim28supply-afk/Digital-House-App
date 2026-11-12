// Visual style of the app (colours, type, corners, glow only; never layout).
// Terminal Noir is the look. Open the app with ?style=off to see the plain look on this browser, ?style=noir to come back.
const KEY = "dh_style";
try {
  const asked = new URLSearchParams(location.search).get("style");
  if (asked === "off" || asked === "noir") localStorage.setItem(KEY, asked);
  const chosen = localStorage.getItem(KEY) ?? "noir";
  if (chosen === "noir") document.documentElement.dataset.style = "noir";
} catch {
  /* private window: Terminal Noir is the default */
  document.documentElement.dataset.style = "noir";
}
