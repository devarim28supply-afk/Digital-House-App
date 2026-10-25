import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";

import { watchAudit } from "../data/audit";
import { auth } from "../firebase";

/*
 * Activity for developers (owner, admins, developers): the Activity page in a
 * floating window in the middle of Darkwood Node (between the side bars, never
 * over them), opening centred. Move it by its top bar, make it bigger
 * by dragging its corner, close it with ✕; where it was and its size are
 * remembered. The button shows a red count of what is new since you last
 * looked: commits, pushes, deploys and pull requests (from /api/activity) and
 * other people's actions in Darkwood (the action log).
 */

const SEEN_KEY = "dh_activity_seen";
const BOX_KEY = "dh_activity_box";
const POLL_MS = 60_000;

type Box = { x: number; y: number; w: number; h: number };
/** The size you last gave the window (it always opens centred). */
function recallSize(area: { w: number; h: number }) {
  let w = 560;
  let h = 640;
  try {
    const b = JSON.parse(localStorage.getItem(BOX_KEY) || "null") as Partial<Box> | null;
    if (b?.w && b?.h) [w, h] = [b.w, b.h];
  } catch {
    /* the default size */
  }
  return { w: Math.min(Math.max(320, w), area.w - 16), h: Math.min(Math.max(240, h), area.h - 16) };
}
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
};
function lastSeen() {
  try {
    const v = Number(localStorage.getItem(SEEN_KEY));
    if (v) return v;
  } catch {
    /* none */
  }
  const now = Date.now();
  remember(SEEN_KEY, String(now)); // the first time: count from now, not all history
  return now;
}

/** The Activity button (with its red count) and the window it opens. */
export function ActivityButton(props: { uid: string }) {
  const [open, setOpen] = createSignal(false);
  const [unseen, setUnseen] = createSignal(0);
  let seen = lastSeen();
  // when each new thing happened, from both sources
  let workTimes: number[] = [];
  let actionTimes: number[] = [];
  const recount = () => setUnseen([...workTimes, ...actionTimes].filter((t) => t > seen).length);

  async function poll() {
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) return;
      const res = await fetch("/api/activity", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const d = (await res.json()) as {
        repos: { commits: { at: string }[]; pushes: { at: string }[]; pulls: { at: string }[] }[];
        deploys: { at?: string }[];
      };
      workTimes = [
        ...d.repos.flatMap((r) => [...r.commits, ...r.pushes, ...r.pulls].map((x) => Date.parse(x.at))),
        ...d.deploys.map((x) => Date.parse(x.at ?? "")),
      ].filter((t) => !Number.isNaN(t));
      recount();
    } catch {
      /* try again next minute */
    }
  }
  onMount(() => {
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    // other people's actions in Darkwood, live (yours are not news to you)
    const stop = watchAudit(
      (list) => {
        actionTimes = list.filter((a) => a.uid !== props.uid).map((a) => a.at);
        recount();
      },
      () => {},
    );
    onCleanup(() => {
      window.clearInterval(timer);
      stop();
    });
  });

  function markSeen() {
    seen = Date.now();
    remember(SEEN_KEY, String(seen));
    recount();
  }
  function toggle() {
    const next = !open();
    setOpen(next);
    if (next) markSeen();
  }

  return (
    <>
      <button
        class="btn activity-btn"
        type="button"
        aria-pressed={open()}
        title="Who committed, pushed and deployed what"
        onClick={toggle}
      >
        Activity
        <Show when={unseen() > 0}>
          <span class="activity-badge" aria-label={`${unseen()} new`}>
            {unseen() > 99 ? "99+" : unseen()}
          </span>
        </Show>
      </button>
      <Show when={open()}>
        <ActivityWindow
          onClose={() => {
            markSeen();
            setOpen(false);
          }}
          onSeen={markSeen}
        />
      </Show>
    </>
  );
}

function ActivityWindow(props: { onClose: () => void; onSeen: () => void }) {
  // It lives in the middle column (the channel and videochat), never over the
  // side bars: its box is measured inside that column.
  const host = document.querySelector<HTMLElement>(".main") ?? document.body;
  const area = () => ({ w: host.clientWidth, h: host.clientHeight });
  const centred = (): Box => {
    const size = recallSize(area());
    return { ...size, x: Math.round((area().w - size.w) / 2), y: Math.round((area().h - size.h) / 2) };
  };
  const [box, setBox] = createSignal(centred());
  let panel: HTMLDivElement | undefined;
  const save = () => remember(BOX_KEY, JSON.stringify(box()));
  // always wholly inside the column
  const fit = (b: Box): Box => {
    const { w: aw, h: ah } = area();
    const w = Math.min(b.w, aw);
    const h = Math.min(b.h, ah);
    return { w, h, x: Math.min(Math.max(0, b.x), aw - w), y: Math.min(Math.max(0, b.y), ah - h) };
  };
  // the column changes size (a side bar slides in or out, the window resizes)
  onMount(() => {
    const ro = new ResizeObserver(() => setBox((b) => fit(b)));
    ro.observe(host);
    onCleanup(() => ro.disconnect());
  });

  // move: drag the top bar
  function startMove(e: PointerEvent) {
    if ((e.target as Element).closest("button, a")) return;
    const start = { px: e.clientX, py: e.clientY, ...box() };
    const head = e.currentTarget as HTMLElement;
    head.setPointerCapture(e.pointerId);
    panel?.classList.add("dragging"); // the page inside must not swallow the pointer
    const move = (ev: PointerEvent) => setBox(fit({ ...start, x: start.x + ev.clientX - start.px, y: start.y + ev.clientY - start.py }));
    const up = () => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      panel?.classList.remove("dragging");
      save();
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
  }
  // resize: drag the bottom-right corner
  function startResize(e: PointerEvent) {
    e.preventDefault();
    const start = { px: e.clientX, py: e.clientY, ...box() };
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);
    panel?.classList.add("dragging");
    const move = (ev: PointerEvent) =>
      setBox(
        fit({
          ...start,
          w: Math.max(320, Math.min(area().w - start.x, start.w + ev.clientX - start.px)),
          h: Math.max(240, Math.min(area().h - start.y, start.h + ev.clientY - start.py)),
        }),
      );
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      panel?.classList.remove("dragging");
      save();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  }

  // the window is open: what arrives meanwhile is seen too
  onMount(() => {
    const timer = window.setInterval(props.onSeen, 15_000);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.clearInterval(timer);
      window.removeEventListener("keydown", onKey);
    });
  });

  return (
    <Portal mount={host}>
    <div
      ref={panel}
      class="activity-window"
      role="dialog"
      aria-label="Activity"
      style={{ left: `${box().x}px`, top: `${box().y}px`, width: `${box().w}px`, height: `${box().h}px` }}
    >
      <header class="activity-window-head" onPointerDown={startMove}>
        <span>› Activity</span>
        <a href={`${import.meta.env.BASE_URL}activity.html`} target="_blank" rel="noopener" title="Open in its own tab">
          ↗
        </a>
        <button class="icon-btn" type="button" aria-label="Close Activity" title="Close (Esc)" onClick={props.onClose}>
          ✕
        </button>
      </header>
      <iframe src={`${import.meta.env.BASE_URL}activity.html?embed`} title="Activity" />
      <div class="activity-window-grip" onPointerDown={startResize} title="Drag to resize" aria-hidden="true" />
    </div>
    </Portal>
  );
}
