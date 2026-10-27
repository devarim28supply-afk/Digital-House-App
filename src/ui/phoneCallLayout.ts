// Phone videochat geometry. Desktop never calls this.
// Other people's cameras are half the phone width, two side by side, 16:9.
// Your own camera is a small picture on top of them. You alone fill the phone.

export type PipSpot = "top" | "left" | "right" | "bottom";

export type PhoneStyle = Record<string, string>;

export type PhonePlan = {
  /** duo: the other person fills the stage and your camera is a small picture */
  mode: "solo" | "duo" | "stack";
  scroll: boolean;
  pipKey?: string;
  grid: PhoneStyle;
  places: Record<string, PhoneStyle>;
};

const full: PhoneStyle = { left: "0", top: "0", width: "100%", height: "100%", zIndex: "1" };

/** Where a dragged self-view lands: the stage edge closest to the pointer. */
export function pipSpotAt(x: number, y: number, width: number, height: number): PipSpot {
  const px = width > 0 ? x / width : 0.5;
  const py = height > 0 ? y / height : 0.5;
  const spots: [PipSpot, number][] = [
    ["top", py],
    ["bottom", 1 - py],
    ["left", px],
    ["right", 1 - px],
  ];
  spots.sort((a, b) => a[1] - b[1]);
  return spots[0][0];
}

function pipBox(spot: PipSpot, wide: boolean, width: number, height: number): PhoneStyle {
  const margin = 12;
  let pw: number;
  let ph: number;
  if (wide) {
    pw = Math.min(Math.max(width * 0.36, 120), 240);
    ph = (pw * 9) / 16;
  } else {
    ph = Math.min(Math.max(height * 0.3, 140), 240);
    pw = (ph * 9) / 16;
  }
  pw = Math.min(pw, Math.max(64, width - margin * 2));
  ph = Math.min(ph, Math.max(64, height - margin * 2));
  const cx = Math.max(margin, (width - pw) / 2);
  const cy = Math.max(margin, (height - ph) / 2);
  let left = margin;
  let top = margin;
  if (spot === "top") {
    left = cx;
    top = margin;
  } else if (spot === "bottom") {
    left = cx;
    top = Math.max(0, height - ph);
  } else if (spot === "left") {
    left = margin;
    top = cy;
  } else {
    left = Math.max(0, width - pw - margin);
    top = cy;
  }
  const px = (n: number) => `${Math.round(n)}px`;
  return { left: px(left), top: px(top), width: px(pw), height: px(ph), zIndex: "2" };
}

/**
 * `keys` is visual order: other people first, you last.
 * `localKey` is your camera, when you are in the call.
 * A one-on-one (you plus one other tile) uses the floating self-view.
 */
export function phonePlan(args: {
  keys: string[];
  localKey?: string;
  landscape: boolean;
  width: number;
  height: number;
  pipSpot: PipSpot;
  pipWide: boolean;
}): PhonePlan {
  const keys = args.keys.filter(Boolean);
  const n = keys.length;
  const places: Record<string, PhoneStyle> = {};
  const empty: PhonePlan = { mode: "solo", scroll: false, grid: {}, places };

  if (n === 0) return empty;

  if (n === 1 && keys[0] === args.localKey) {
    places[keys[0]] = full;
    return { mode: "solo", scroll: false, grid: {}, places };
  }

  const others = keys.filter((key) => key !== args.localKey);
  const gridKeys = others.length > 0 ? others : keys;
  const usePip = Boolean(args.localKey && others.length > 0 && keys.includes(args.localKey));
  const rowH = Math.max(72, Math.round((Math.max(1, args.width) / 2) * (9 / 16)));
  const rows = Math.max(1, Math.ceil(gridKeys.length / 2));
  gridKeys.forEach((key, i) => {
    places[key] = { gridColumn: String((i % 2) + 1), gridRow: String(Math.floor(i / 2) + 1) };
  });
  if (usePip && args.localKey) places[args.localKey] = pipBox(args.pipSpot, args.pipWide, args.width, args.height);
  return {
    mode: usePip ? "duo" : "stack",
    scroll: true,
    pipKey: usePip ? args.localKey : undefined,
    grid: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gridTemplateRows: `repeat(${rows}, ${rowH}px)`,
      alignContent: "start",
      width: "100%",
    },
    places,
  };
}

/** people | the share shelf | one share entered beside the person sharing it */
export type ShareView = "people" | "shelf" | "open";

const SHARE_GAP = 10;

function px(n: number): string {
  return `${Math.round(n)}px`;
}

/** A spot on the page to the right of the people. */
function shareBox(x: number, y: number, width: number, height: number): PhoneStyle {
  return {
    left: `calc(100% + ${px(x)})`,
    top: px(y),
    width: px(width),
    height: px(height),
    zIndex: "1",
  };
}

/** n 16:9 cards in a column, shrunk until the column fits the stage. */
function fitStack(n: number, width: number, height: number): { w: number; h: number; top: number; left: number } {
  const gaps = SHARE_GAP * Math.max(0, n - 1);
  let cardH = n > 0 ? (height - gaps) / n : 0;
  let cardW = (cardH * 16) / 9;
  if (cardW > width) {
    cardW = width;
    cardH = (cardW * 9) / 16;
  }
  cardW = Math.max(0, cardW);
  cardH = Math.max(0, cardH);
  const stackH = n * cardH + gaps;
  return {
    w: cardW,
    h: cardH,
    top: Math.max(0, (height - stackH) / 2),
    left: Math.max(0, (width - cardW) / 2),
  };
}

/** n 16:9 cards in a row, shrunk until the row fits the stage. */
function fitRow(n: number, width: number, height: number): { w: number; h: number; top: number; left: number } {
  const gaps = SHARE_GAP * Math.max(0, n - 1);
  let cardW = n > 0 ? (width - gaps) / n : 0;
  let cardH = (cardW * 9) / 16;
  if (cardH > height) {
    cardH = height;
    cardW = (cardH * 16) / 9;
  }
  cardW = Math.max(0, cardW);
  cardH = Math.max(0, cardH);
  const rowW = n * cardW + gaps;
  return {
    w: cardW,
    h: cardH,
    top: Math.max(0, (height - cardH) / 2),
    left: Math.max(0, (width - rowW) / 2),
  };
}

/**
 * Screen shares sit one page to the right of the people.
 * Shelf: every share is a 16:9 card, stacked and centered, all of them visible.
 * Entered: the tapped share and the person sharing it are two 16:9 pictures
 * (stacked upright, side by side sideways). The other shares hide.
 */
export function phoneSharePlaces(args: {
  screenKeys: string[];
  openKey?: string;
  sharerKey?: string;
  landscape: boolean;
  width: number;
  height: number;
}): Record<string, PhoneStyle> {
  const places: Record<string, PhoneStyle> = {};
  const keys = args.screenKeys.filter(Boolean);
  if (keys.length === 0) return places;
  const open = args.openKey && keys.includes(args.openKey) ? args.openKey : undefined;

  if (!open) {
    const fit = fitStack(keys.length, args.width, args.height);
    keys.forEach((key, i) => {
      places[key] = shareBox(fit.left, fit.top + i * (fit.h + SHARE_GAP), fit.w, fit.h);
    });
    return places;
  }

  for (const key of keys) {
    if (key !== open) places[key] = { display: "none" };
  }
  const fit = args.landscape ? fitRow(2, args.width, args.height) : fitStack(2, args.width, args.height);
  places[open] = shareBox(fit.left, fit.top, fit.w, fit.h);
  if (args.sharerKey) {
    const x = args.landscape ? fit.left + fit.w + SHARE_GAP : fit.left;
    const y = args.landscape ? fit.top : fit.top + fit.h + SHARE_GAP;
    places[args.sharerKey] = shareBox(x, y, fit.w, fit.h);
  }
  return places;
}

/**
 * Where a finished horizontal swipe lands.
 * Left from the people opens the shelf. Right from the shelf returns to the people.
 * Right from an entered share returns to the shelf. Left from the shelf does not enter.
 */
export function shareSwipeTarget(view: ShareView, dx: number, width: number): ShareView {
  const w = Math.max(1, width);
  if (Math.abs(dx) < Math.min(48, w * 0.2)) return view;
  if (dx < 0 && view === "people") return "shelf";
  if (dx > 0 && view === "shelf") return "people";
  if (dx > 0 && view === "open") return "shelf";
  return view;
}
