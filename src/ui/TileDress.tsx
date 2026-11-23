import { For, type JSX, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";

import "./tile-dress.css";

/**
 * What a person can put on their own tile in a videochat, the same as in the
 * desktop app (Kaalob: "update the browser's videochat with current desktop's
 * curtains and window with blinders"):
 *
 *  - curtains, drawn over their picture from both sides (desktop: ui/curtains.dart)
 *  - neighbor mode: the tile is the wall of a house with a window, and they
 *    stand in the room behind the blinds (desktop: ui/neighbor.dart)
 *
 * The pictures are the desktop app's own (public/dress/). Everything a person
 * sets travels as their own LiveKit attributes, under the same names the
 * desktop app uses, so a browser and a desktop app in one call show the same.
 */

const BASE = `${import.meta.env.BASE_URL}dress/`;

export const CURTAIN_ATTR = "dh-curtain";
export const CURTAIN_COLOR_ATTR = "dh-curtain-color";
export const NEIGHBOR_ATTR = "dh-neighbor";
export const LIFT_ATTR = "dh-neighbor-lift";
export const TILT_ATTR = "dh-neighbor-tilt";
/** What a person sets on their own tile: these change many times a second while curtains or blinds are dragged. */
export const DRESS_ATTRS = new Set([CURTAIN_ATTR, CURTAIN_COLOR_ATTR, NEIGHBOR_ATTR, LIFT_ATTR, TILT_ATTR]);
/** kept in this browser for your next call (the neighbor window is not kept: Kaalob's rule) */
export const CURTAIN_COLOR_KEY = "dh_curtain_color";

/** The five curtain colors: the name carried in the call, and the dot shown in the picker. */
export const CURTAIN_COLORS: Record<string, string> = {
  red: "#7a1f2b",
  blue: "#1f3f8f",
  green: "#1f6b3a",
  purple: "#5b2a91",
  black: "#2b2b2e",
};

// The cloth's picture is burgundy. Its red part holds the folds' light and shade, so each other
// color is made from that red part alone: so much of it into red, into green, into blue.
const DYES: Record<string, [number, number, number]> = {
  blue: [0.2, 0.32, 1.0],
  green: [0.14, 0.62, 0.28],
  purple: [0.62, 0.18, 0.98],
  black: [0.27, 0.27, 0.3],
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The dyes, as filters the cloth pictures use. Once on the page, for every tile. */
let dyesMade = false;
function makeDyes() {
  if (dyesMade || typeof document === "undefined") return;
  dyesMade = true;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
  for (const [name, d] of Object.entries(DYES)) {
    const filter = document.createElementNS(ns, "filter");
    filter.setAttribute("id", `dh-dye-${name}`);
    filter.setAttribute("color-interpolation-filters", "sRGB");
    const m = document.createElementNS(ns, "feColorMatrix");
    m.setAttribute("type", "matrix");
    m.setAttribute("values", `${d[0]} 0 0 0 0  ${d[1]} 0 0 0 0  ${d[2]} 0 0 0 0  0 0 0 1 0`);
    filter.appendChild(m);
    svg.appendChild(filter);
  }
  document.body.appendChild(svg);
}

/**
 * The curtains over a person's picture: two halves of one curtain, one from
 * each side. closed: 0 = open (slid off the tile, gone), 1 = closed (they meet
 * in the middle). On your own tile (onDrag given) you drag them: a side toward
 * the middle to close, toward the edge to open. While open, a small tab at each
 * edge shows where to pull.
 */
export function Curtains(props: { closed: number; color: string; onDrag?: (closed: number, done: boolean) => void }) {
  makeDyes();
  const [dragging, setDragging] = createSignal(false);
  const c = () => clamp(props.closed, 0, 1);
  const color = () => (CURTAIN_COLORS[props.color] ? props.color : "black");
  const dye = () => (DYES[color()] ? `url(#dh-dye-${color()})` : undefined);
  // the cloth hangs bigger than the tile (its own edges are uneven): 4% of the tile's width past
  // the outer side; as it opens it slides out by half the tile
  const off = () => `${-4 - (1 - c()) * 50.2}%`;

  // Held and dragged: the drag is followed on the whole page until the button (or the finger, or
  // the touchpad) lets go. It does not hang on the piece that was grabbed: that piece changes
  // under the pointer while the curtains move (the tab goes when they start to close), and a drag
  // tied to it broke off, most of all on a MacBook's touchpad (Kaalob).
  let from: { id: number; left: boolean; at: number; x: number; half: number; moved: boolean } | undefined;
  let at = 0;
  function move(e: PointerEvent) {
    if (!from || e.pointerId !== from.id || !props.onDrag) return;
    const dx = e.clientX - from.x;
    if (!from.moved && Math.abs(dx) < 3) return;
    from.moved = true;
    setDragging(true);
    // the left curtain closes to the right, the right one to the left; both move together
    at = clamp(from.at + (from.left ? dx : -dx) / from.half, 0, 1);
    props.onDrag(at, false);
  }
  function up(e: PointerEvent) {
    if (!from || e.pointerId !== from.id) return;
    const was = from;
    release();
    if (!was.moved || !props.onDrag) return;
    // let go near an end: all the way open, or all the way closed
    props.onDrag(at > 0.94 ? 1 : at < 0.06 ? 0 : at, true);
  }
  function release() {
    from = undefined;
    setDragging(false);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", up, true);
  }
  onCleanup(release);
  function down(e: PointerEvent) {
    if (!props.onDrag || from || (e.pointerType === "mouse" && e.button !== 0)) return;
    const root = (e.currentTarget as HTMLElement).closest(".dress-curtains")?.getBoundingClientRect();
    if (!root || !root.width) return;
    // not the tile's own drag (its place in the call, the phone's small self-view), no text
    // marked, no picture dragged out of the page
    e.stopPropagation();
    e.preventDefault();
    at = c();
    from = { id: e.pointerId, left: e.clientX < root.left + root.width / 2, at, x: e.clientX, half: root.width / 2, moved: false };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
  }
  const grab = {
    onPointerDown: down,
    // after a drag, the tile must not take the letting go for a double-tap
    onPointerUp: (e: PointerEvent) => from?.moved && e.stopPropagation(),
    // the tile itself is dragged to another place in the call: not from here
    onDragStart: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    },
  };

  return (
    <div class="dress-curtains" classList={{ mine: Boolean(props.onDrag), dragging: dragging() }} style={{ "--c": String(c()) }}>
      {/* the picture between the curtains blurs and darkens as they close */}
      <Show when={c() > 0}>
        <div class="dress-dim" />
      </Show>
      {/* yours stay on the page while open too (off the tile), so nothing comes and goes during a drag */}
      <Show when={c() > 0 || props.onDrag}>
        <img class="dress-cloth left" src={`${BASE}curtain-left.png`} alt="" draggable={false} style={{ left: off(), filter: dye() }} {...grab} />
        <img class="dress-cloth right" src={`${BASE}curtain-right.png`} alt="" draggable={false} style={{ right: off(), filter: dye() }} {...grab} />
      </Show>
      {/* open, and yours: a tab at each edge to pull them out by */}
      <Show when={props.onDrag}>
        <span class="dress-tab left" classList={{ gone: c() >= 0.02 }} title="Drag to close your curtains" style={{ background: CURTAIN_COLORS[color()] }} {...grab} />
        <span class="dress-tab right" classList={{ gone: c() >= 0.02 }} title="Drag to close your curtains" style={{ background: CURTAIN_COLORS[color()] }} {...grab} />
      </Show>
    </div>
  );
}

// ---- neighbor mode ---------------------------------------------------------

export type NeighborLook = {
  /** the night wall, or the day wall */
  night: boolean;
  /** the webcam's height against the glass (1 = as tall as the glass) */
  cam: number;
  /** the webcam's brightness (1 = as it is) */
  bright: number;
  /** the webcam moved down from the middle of the glass, in glass heights */
  up: number;
  /** the blinds: pulled up (0 = all the way down), and how far the slats are shut (0 flat open, 1 shut) */
  lift: number;
  tilt: number;
  /** the monitor: which way it stands, its middle as a part of the tile, and its size */
  monitor: "flat" | "left" | "right";
  mx: number;
  my: number;
  monitorSize: number;
};

/** The six looks, the desktop app's own (the six Kaalob set and saved): 1, 2, 3 by night, 4, 5, 6 by day. */
export const NEIGHBOR_LOOKS: Record<number, NeighborLook> = {
  1: { night: true, cam: 0.58, bright: 1, up: 0.208, lift: 0, tilt: 0.28, monitor: "left", mx: 0.6495, my: 0.6649, monitorSize: 1.61 },
  2: { night: true, cam: 0.58, bright: 1, up: 0.208, lift: 0, tilt: 0.28, monitor: "right", mx: 0.3793, my: 0.6591, monitorSize: 1.61 },
  3: { night: true, cam: 0.58, bright: 1, up: 0.208, lift: 0, tilt: 0.28, monitor: "flat", mx: 0.5035, my: 0.7501, monitorSize: 1.52 },
  4: { night: false, cam: 0.58, bright: 0.2, up: 0.208, lift: 0.6817, tilt: 0.28, monitor: "left", mx: 0.6495, my: 0.6649, monitorSize: 1.61 },
  5: { night: false, cam: 0.58, bright: 0.2, up: 0.208, lift: 0.678, tilt: 0.28, monitor: "right", mx: 0.3793, my: 0.6591, monitorSize: 1.61 },
  6: { night: false, cam: 0.58, bright: 0.2, up: 0.208, lift: 0.5974, tilt: 0.28, monitor: "flat", mx: 0.5035, my: 0.7501, monitorSize: 1.52 },
};

/** The highest the blinds may be pulled. Never fully open: the window always keeps some blind (Kaalob). */
export const NEIGHBOR_MAX_LIFT = 0.6817;

// the pictures' grid, and where the glass and the blinds are on it
const W = 1102;
const H = 620;
const GLASS = { x: 377, y: 150, w: 357, h: 353 };
const BLINDS = { x: 372, y: 146, w: 368, h: 362 };
const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

/** Where the person's picture stands behind the glass: for the tile's own video and its camera-off face. */
export function neighborCamStyle(look: NeighborLook): JSX.CSSProperties {
  return {
    left: pct((GLASS.x + GLASS.w / 2) / W),
    top: pct((GLASS.y + GLASS.h / 2 + GLASS.h * look.up) / H),
    width: "auto",
    height: pct((GLASS.h * look.cam) / H),
    "aspect-ratio": "16 / 9",
    transform: "translate(-50%, -50%)",
    // it fills its place behind the glass
    "object-fit": "cover",
  };
}

/**
 * Everything of the window that is in front of the person: the room's dark,
 * the monitor and its light, the blinds, the glass, the wall. The tile puts
 * its picture behind this (neighborCamStyle).
 */
export function NeighborFront(props: { look: NeighborLook; lift?: number; tilt?: number; onLift?: (lift: number, done: boolean) => void }) {
  const liftNow = () => clamp(props.lift ?? props.look.lift, 0, NEIGHBOR_MAX_LIFT);
  const tiltNow = () => clamp(props.tilt ?? props.look.tilt, 0, 1);
  const glow = () => {
    const [a, b] = props.look.night ? [0.42, 0.12] : [0.24, 0.07];
    return `radial-gradient(ellipse 44.1% 62% at 50% 62%, rgba(150,190,255,${a}) 0, rgba(150,190,255,${b}) 50%, rgba(150,190,255,0) 100%)`;
  };

  // White blinds: a head rail, slats that all tilt together, two cords, and the bottom bar the
  // blind is pulled up by. What is pulled up is gathered into the bar.
  let canvas: HTMLCanvasElement | undefined;
  const [size, setSize] = createSignal({ w: 0, h: 0 });
  createEffect(() => {
    const el = canvas;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    measure();
    onCleanup(() => watch.disconnect());
  });
  createEffect(() => {
    const el = canvas;
    const { w, h } = size();
    const lift = liftNow();
    const tilt = tiltNow();
    const night = props.look.night;
    if (!el || !w || !h) return;
    const ratio = Math.min(3, window.devicePixelRatio || 1);
    el.width = Math.round(w * ratio);
    el.height = Math.round(h * ratio);
    const g = el.getContext("2d");
    if (!g) return;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, w, h);
    // at night the room's light is behind the slats: seen from outside they are dim
    const k = night ? 0.5 : 1;
    const c = (v: number, a = 1) => `rgba(${Math.round(v * k)},${Math.round(v * k)},${Math.round((v - 5) * k)},${a})`;
    const head = h * 0.045;
    const bar = h * 0.05;
    const hang = (h - head - bar) * (1 - lift);
    const pitch = Math.max(3, h / 24);
    const slat = pitch * (0.14 + 0.9 * tilt);
    // the slats that hang between the head rail and the bar
    g.save();
    g.beginPath();
    g.rect(0, head, w, hang);
    g.clip();
    for (let y = head; y < head + hang; y += pitch) {
      const fill = g.createLinearGradient(0, y, 0, y + slat);
      fill.addColorStop(0, c(251));
      fill.addColorStop(0.55, c(233));
      fill.addColorStop(1, c(189));
      g.fillStyle = fill;
      g.fillRect(0, y, w, slat);
      g.fillStyle = "rgba(0,0,0,0.28)";
      g.fillRect(0, y + slat, w, 1.2);
    }
    g.strokeStyle = c(235, 0.75);
    g.lineWidth = 1;
    for (const x of [0.18, 0.82]) {
      g.beginPath();
      g.moveTo(w * x, head);
      g.lineTo(w * x, head + hang);
      g.stroke();
    }
    g.restore();
    const rail = (y: number, tall: number, bottom: number) => {
      g.fillStyle = "rgba(0,0,0,0.5)";
      g.fillRect(0, y + 2, w, tall);
      const fill = g.createLinearGradient(0, y, 0, y + tall);
      fill.addColorStop(0, c(247));
      fill.addColorStop(1, c(bottom));
      g.fillStyle = fill;
      g.fillRect(0, y, w, tall);
    };
    rail(0, head, 210);
    rail(head + hang, bar, 196);
  });

  // your own window: the blinds' bottom bar is dragged up and down. The pull is counted from
  // where the bar was when it was grabbed, so nothing is lost when the hand is faster than the picture.
  // The pull is followed on the whole page until it is let go (as the curtains' drag is).
  let pull: { id: number; y: number; lift: number; travel: number } | undefined;
  let at = 0;
  function move(e: PointerEvent) {
    if (!pull || e.pointerId !== pull.id || !props.onLift) return;
    at = clamp(pull.lift - (e.clientY - pull.y) / pull.travel, 0, NEIGHBOR_MAX_LIFT);
    props.onLift(at, false);
  }
  function up(e: PointerEvent) {
    if (!pull || e.pointerId !== pull.id) return;
    release();
    props.onLift?.(at, true);
  }
  function release() {
    pull = undefined;
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", up, true);
  }
  onCleanup(release);
  function down(e: PointerEvent) {
    if (!props.onLift || pull || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.stopPropagation();
    e.preventDefault();
    at = liftNow();
    pull = { id: e.pointerId, y: e.clientY, lift: at, travel: (size().h || 1) * (1 - 0.045 - 0.05) };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
  }

  const blindsBox = { left: pct(BLINDS.x / W), top: pct(BLINDS.y / H), width: pct(BLINDS.w / W), height: pct(BLINDS.h / H) };
  const cam = () => ({ ...neighborCamStyle(props.look), "object-fit": undefined });
  return (
    <div class="dress-neighbor" classList={{ night: props.look.night }}>
      {/* the room is dimmer than the street: the picture is darkened by a veil; its top and bottom fade into the dark of the room */}
      <div class="dress-cam" style={cam()}>
        <Show when={props.look.bright < 1}>
          <div class="dress-veil" style={{ background: `rgba(0,0,0,${1 - props.look.bright})` }} />
        </Show>
        <div class="dress-fade" />
      </div>
      {/* the monitor, seen from behind, and the light of its screen coming round its edge */}
      <div class="dress-monitor" style={{ left: pct(props.look.mx), top: pct(props.look.my), width: pct((204 * props.look.monitorSize) / W) }}>
        <div class="dress-glow" style={{ background: glow() }} />
        <img src={`${BASE}neighbor/monitor-${props.look.monitor}.png`} alt="" draggable={false} />
      </div>
      {/* the blinds, inside the room behind the glass */}
      <canvas ref={canvas} class="dress-blinds" style={blindsBox} />
      {/* what the glass reflects, then the wall and the whole window with only the two panes clear */}
      <img class="dress-glass" src={`${BASE}neighbor/${props.look.night ? "glass-night" : "glass"}.png`} alt="" draggable={false} />
      <img class="dress-wall" src={`${BASE}neighbor/${props.look.night ? "wall-night" : "wall"}.png`} alt="" draggable={false} />
      <Show when={props.onLift}>
        <div class="dress-blinds-box" style={blindsBox}>
          <span
            class="dress-bar"
            title="Drag to pull your blinds up or down"
            style={{ top: `calc(${pct(0.045 + (1 - 0.045 - 0.05) * (1 - liftNow()))} - 7px)` }}
            onPointerDown={down}
            onPointerUp={(e) => e.stopPropagation()}
            onDblClick={(e) => e.stopPropagation()}
            onDragStart={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          />
        </div>
      </Show>
    </div>
  );
}

/** Your own tile's settings: the curtain color, neighbor mode, the blinds' slats. */
export type TileDress = {
  curtainColor: string;
  onCurtainColor: (color: string) => void;
  neighbor: number;
  onNeighbor: (look: number) => void;
  tilt: number;
  onTilt: (tilt: number, done: boolean) => void;
};

/**
 * The gear on your own tile, and its panel. The panel floats over the page
 * beside the gear (it is not inside the tile, so a small tile cannot cut it off).
 */
export function TileDressGear(props: { dress: TileDress }) {
  const [at, setAt] = createSignal<{ top: number; left: number } | undefined>();
  let button: HTMLButtonElement | undefined;
  let panel: HTMLDivElement | undefined;
  function toggle() {
    if (at()) return setAt(undefined);
    const box = button?.getBoundingClientRect();
    if (!box) return;
    // beside the gear, toward the side with more room, and always on the page
    const wide = 232;
    const left = box.right + 8 + wide < window.innerWidth ? box.right + 8 : Math.max(8, box.left - 8 - wide);
    setAt({ top: Math.max(8, Math.min(box.top, window.innerHeight - 300)), left });
  }
  createEffect(() => {
    if (!at()) return;
    const close = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (panel?.contains(t) || button?.contains(t))) return;
      setAt(undefined);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setAt(undefined);
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", esc);
    window.addEventListener("resize", () => setAt(undefined), { once: true });
    onCleanup(() => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", esc);
    });
  });
  const stop = (e: Event) => e.stopPropagation();
  return (
    <div class="dress-gear" classList={{ open: Boolean(at()) }} onClick={stop} onDblClick={stop} onPointerDown={stop} onPointerUp={stop}>
      <button ref={button} type="button" title="My tile: curtains and neighbor mode" aria-label="My tile: curtains and neighbor mode" aria-haspopup="dialog" aria-expanded={Boolean(at())} onClick={toggle}>
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3.2" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
      </button>
      <Show when={at()}>
        {(where) => (
          <Portal>
            <div ref={panel} class="dress-panel" role="dialog" aria-label="My tile" style={{ top: `${where().top}px`, left: `${where().left}px` }}>
              <span class="dress-label">Curtain color</span>
              <div class="dress-row">
                <For each={Object.entries(CURTAIN_COLORS)}>
                  {([name, color]) => (
                    <button type="button" class="dress-dot" title={name} aria-label={`${name} curtains`} aria-pressed={props.dress.curtainColor === name} style={{ background: color }} onClick={() => props.dress.onCurtainColor(name)} />
                  )}
                </For>
              </div>
              <span class="dress-label">Neighbor mode</span>
              {/* off, the three night looks, the three day looks */}
              <For each={[["", [0]], ["Night", [1, 2, 3]], ["Day", [4, 5, 6]]] as [string, number[]][]}>
                {([label, looks]) => (
                  <div class="dress-row">
                    <Show when={label}>
                      <span class="dress-when">{label}</span>
                    </Show>
                    <For each={looks}>
                      {(n) => (
                        <button type="button" class="dress-look" classList={{ off: n === 0 }} title={n === 0 ? "Your tile as usual" : `Your tile as a house window, look ${n}`} aria-pressed={props.dress.neighbor === n} onClick={() => props.dress.onNeighbor(n)}>
                          {n === 0 ? "Off" : n}
                        </button>
                      )}
                    </For>
                  </div>
                )}
              </For>
              {/* your blinds' slats: turned open or shut (pulling the blind up and down is done on the window itself, by its bottom bar) */}
              <Show when={props.dress.neighbor !== 0}>
                <span class="dress-when">Slats</span>
                <div class="dress-row dress-slats">
                  <span>open</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    aria-label="Slats, from open to shut"
                    value={props.dress.tilt}
                    onInput={(e) => props.dress.onTilt(Number(e.currentTarget.value), false)}
                    onChange={(e) => props.dress.onTilt(Number(e.currentTarget.value), true)}
                  />
                  <span>shut</span>
                </div>
              </Show>
            </div>
          </Portal>
        )}
      </Show>
    </div>
  );
}
