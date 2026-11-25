/**
 * Streaming colors, the same as in the desktop app (lib/data/stream_colors.dart):
 * whoever streams has a glowing dot beside the name on their webcam tile, and
 * their streaming screen glows around its border in the same color.
 */
export const STREAM_COLOR_ATTR = "dh-stream-color";
/** kept in this browser for your next call ("" = auto) */
export const STREAM_COLOR_KEY = "dh_stream_color";
export const STREAM_PALETTE = ["#4ADE80", "#38BDF8", "#F472B6", "#FACC15", "#A78BFA", "#FB923C", "#F87171", "#2DD4BF"];

/** "#RRGGBB" in capitals, or undefined when it is not a color. */
export const streamHex = (text: string | undefined) => (text && /^#[0-9a-f]{6}$/i.test(text) ? text.toUpperCase() : undefined);

/**
 * Everyone streaming, their id -> the color they picked ("" = auto). Auto gives
 * each person a color nobody else has (while there are enough), worked out the
 * same way everywhere: this must stay the same as the desktop app's.
 */
export function streamColors(streamers: Map<string, string | undefined>) {
  const out = new Map<string, string>();
  for (const [id, own] of streamers) {
    const hex = streamHex(own);
    if (hex) out.set(id, hex);
  }
  const auto = [...streamers.keys()].filter((id) => !out.has(id)).sort();
  for (const id of auto) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 4294967296;
    const order = STREAM_PALETTE.map((_, i) => STREAM_PALETTE[(h + i) % STREAM_PALETTE.length]);
    const used = new Set(out.values());
    out.set(id, order.find((c) => !used.has(c)) ?? order[0]);
  }
  return out;
}

/** A color from the slider (0 to 360 around the color wheel). */
export function hueHex(hue: number) {
  const s = 0.75;
  const f = (n: number) => {
    const k = (n + hue / 60) % 6;
    return Math.round((1 - s * Math.max(0, Math.min(k, 4 - k, 1))) * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(5)}${f(3)}${f(1)}`.toUpperCase();
}

export function hueOf(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!d) return 0;
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round(h * 60);
}
