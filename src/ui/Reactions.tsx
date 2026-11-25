import { For, Show, createSignal, onCleanup, onMount } from "solid-js";

import "./reactions.css";

/**
 * Reactions on a shared screen or a Stream, the same as in the desktop app
 * (ui/reactions.dart): pick a moving emoji or a word, click a place on the
 * picture, and everyone in the call sees it land there with a ring and your
 * name. A LiveKit data message, the same one the desktop app sends; nothing is
 * kept anywhere.
 */
export const REACT_TOPIC = "dh-react";

/** the moving emoji, by their own code (public/reactions, Noto Emoji Animation, CC BY 4.0) */
export const REACT_EMOJI = ["1f44d", "2764", "1f602", "1f62e", "1f525", "1f480", "1f440", "1f91f"];
export const REACT_WORDS = ["NICE", "LOL", "WOW", "FIRE", "THIS", "WTF", "KILL"];
const NAMES: Record<string, string> = { "1f44d": "Thumbs up", "2764": "Heart", "1f602": "Laughing", "1f62e": "Surprised", "1f525": "Fire", "1f480": "Skull", "1f440": "Eyes", "1f91f": "I love you" };
const LIFE_MS = 3200;
const BASE = `${import.meta.env.BASE_URL}reactions/`;

/** sid: the video's own id in the call. x, y: 0 to 1 of the picture itself, so it is the same spot on everyone's tile. */
export type Reaction = { sid: string; what: string; x: number; y: number; name: string; color: string };

export function packReaction(sid: string, what: string, x: number, y: number) {
  return new TextEncoder().encode(JSON.stringify({ sid, r: what, x: Number(x.toFixed(4)), y: Number(y.toFixed(4)) }));
}

/** What someone sent, or undefined when it is not a reaction we know (never shown as it came). */
export function unpackReaction(data: Uint8Array, name: string, color: string): Reaction | undefined {
  try {
    const m = JSON.parse(new TextDecoder().decode(data)) as { sid?: unknown; r?: unknown; x?: unknown; y?: unknown } | null;
    if (!m || typeof m.sid !== "string" || typeof m.r !== "string" || typeof m.x !== "number" || typeof m.y !== "number") return undefined;
    if (!REACT_EMOJI.includes(m.r) && !REACT_WORDS.includes(m.r)) return undefined;
    const unit = (v: number) => Math.min(1, Math.max(0, v));
    return { sid: m.sid, what: m.r, x: unit(m.x), y: unit(m.y), name, color };
  } catch {
    return undefined;
  }
}

/** What is on the pictures right now, and which picture's bar you have open. One per call. */
export function createReactBoard() {
  const [live, setLive] = createSignal<Reaction[]>([]);
  const [open, setOpen] = createSignal<string | undefined>();
  const [picked, setPicked] = createSignal(REACT_EMOJI[0]);
  const timers = new Set<number>();
  onCleanup(() => timers.forEach((t) => window.clearTimeout(t)));
  let loaded = false;
  return {
    live,
    open,
    setOpen,
    picked,
    setPicked,
    add(r: Reaction) {
      setLive((list) => [...list, r].slice(-40));
      const t = window.setTimeout(() => {
        timers.delete(t);
        setLive((list) => list.filter((x) => x !== r));
      }, LIFE_MS);
      timers.add(t);
    },
    /** someone streams: have the moving pictures ready, so a reaction shows at once */
    load() {
      if (loaded) return;
      loaded = true;
      for (const code of REACT_EMOJI) new Image().src = `${BASE}${code}.webp`;
    },
  };
}
export type ReactBoard = ReturnType<typeof createReactBoard>;

/** Where the picture itself is on the page: the video is shown whole, black beside it or above it. */
function pictureRect(video: HTMLVideoElement | undefined) {
  const box = video?.getBoundingClientRect();
  if (!video || !box || !box.width || !box.height) return undefined;
  const shape = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
  const w = box.width / box.height > shape ? box.height * shape : box.width;
  const h = w / shape;
  return { left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2, w, h };
}

const isWord = (what: string) => REACT_WORDS.includes(what);

/**
 * The layer over one picture. onSend: you can react on it (its button and bar).
 * onButton: this is a small corner picture, its button does this instead.
 */
export function ReactionLayer(props: {
  board: ReactBoard;
  sid: string;
  video: () => HTMLVideoElement | undefined;
  onSend?: (what: string, x: number, y: number) => void;
  onButton?: () => void;
}) {
  const open = () => Boolean(props.onSend) && props.board.open() === props.sid;
  const stop = (e: Event) => e.stopPropagation();
  let from: { x: number; y: number } | undefined;
  let last = 0;
  function drop(e: PointerEvent) {
    e.stopPropagation();
    const was = from;
    from = undefined;
    if (!was || Math.hypot(e.clientX - was.x, e.clientY - was.y) > 8) return;
    const r = pictureRect(props.video());
    if (!r) return;
    const x = (e.clientX - r.left) / r.w;
    const y = (e.clientY - r.top) / r.h;
    // the black beside the picture
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    if (e.timeStamp - last < 120) return;
    last = e.timeStamp;
    props.onSend?.(props.board.picked(), x, y);
  }
  // The bar keeps its two rows and shrinks to fit its screen (as the desktop app's does), and is never
  // more than a third of the screen high.
  let controls: HTMLDivElement | undefined;
  const fit = () => {
    const tile = controls?.parentElement;
    if (!tile || !controls || !controls.offsetWidth || !controls.offsetHeight) return;
    const s = Math.min(1, (tile.clientWidth - 16) / controls.offsetWidth, open() ? tile.clientHeight / 3 / controls.offsetHeight : 1);
    controls.style.setProperty("--fit", String(Math.max(0.2, s)));
  };
  function watchFit(el: HTMLDivElement) {
    controls = el;
    const watch = new ResizeObserver(fit);
    queueMicrotask(() => {
      if (el.parentElement) watch.observe(el.parentElement);
      watch.observe(el);
    });
    onCleanup(() => watch.disconnect());
  }
  const face = () => (
    <>
      <img src={`${BASE}button.svg`} alt="" draggable={false} /> React
    </>
  );
  return (
    <>
      {/* the bar is open: a click on the picture drops the reaction there, and the tile itself does not get it */}
      <Show when={open()}>
        <div
          class="react-catch"
          onPointerDown={(e) => {
            e.stopPropagation();
            from = e.button === 0 ? { x: e.clientX, y: e.clientY } : undefined;
          }}
          onPointerUp={drop}
          onPointerCancel={() => (from = undefined)}
          onClick={stop}
          onDblClick={stop}
        />
      </Show>
      <div class="react-layer">
        <For each={props.board.live().filter((r) => r.sid === props.sid)}>{(r) => <Landed r={r} video={props.video} />}</For>
      </div>
      <Show when={props.onSend || props.onButton}>
        <div ref={watchFit} class="react-controls" classList={{ small: Boolean(props.onButton) }} onClick={stop} onDblClick={stop} onPointerDown={stop} onPointerUp={stop}>
          <Show
            when={open()}
            fallback={
              <button type="button" class="react-btn" title="React: pick one, then click a spot on the screen" onClick={() => (props.onButton ? props.onButton() : props.board.setOpen(props.sid))}>
                {face()}
              </button>
            }
          >
            <div class="react-bar" role="toolbar" aria-label="Reactions">
              <div class="react-rows">
                <div class="react-row">
                  <For each={REACT_EMOJI}>
                    {(code) => (
                      <button type="button" aria-label={NAMES[code]} title={NAMES[code]} aria-pressed={props.board.picked() === code} onClick={() => props.board.setPicked(code)}>
                        <img src={`${BASE}${code}.webp`} alt="" draggable={false} />
                      </button>
                    )}
                  </For>
                </div>
                <div class="react-row">
                  <For each={REACT_WORDS}>
                    {(word) => (
                      <button type="button" class="word" aria-pressed={props.board.picked() === word} onClick={() => props.board.setPicked(word)}>
                        {word}
                      </button>
                    )}
                  </For>
                </div>
              </div>
              <button type="button" class="react-close" title="Close reactions" aria-label="Close reactions" onClick={() => props.board.setOpen(undefined)}>
                ×
              </button>
            </div>
          </Show>
        </div>
      </Show>
    </>
  );
}

/** A reaction that landed: two rings going out, the emoji or word popping in, held, then gone. It stays on its spot while the picture is zoomed or resized. */
function Landed(props: { r: Reaction; video: () => HTMLVideoElement | undefined }) {
  let el: HTMLDivElement | undefined;
  onMount(() => {
    let frame = 0;
    const place = () => {
      const pic = pictureRect(props.video());
      const layer = el?.parentElement?.getBoundingClientRect();
      if (el && pic && layer) {
        el.style.left = `${pic.left - layer.left + props.r.x * pic.w}px`;
        el.style.top = `${pic.top - layer.top + props.r.y * pic.h}px`;
        el.style.setProperty("--u", `${Math.min(90, Math.max(18, layer.height * 0.09))}px`);
      }
      frame = requestAnimationFrame(place);
    };
    place();
    onCleanup(() => cancelAnimationFrame(frame));
  });
  return (
    <div ref={el} class="react-landed" style={{ "--who": props.r.color }}>
      <i class="react-ring" />
      <i class="react-ring late" />
      <div class="react-pop">
        <Show when={isWord(props.r.what)} fallback={<img src={`${BASE}${props.r.what}.webp`} alt="" draggable={false} />}>
          <b>{props.r.what}</b>
        </Show>
        <span>{props.r.name}</span>
      </div>
    </div>
  );
}
