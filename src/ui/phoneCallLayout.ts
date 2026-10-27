// Phone videochat geometry. Desktop never calls this.
// You alone fill the phone. With other people, the call is only them.
// A desktop camera stays 16:9. A phone camera is one vertical tile of that
// same height, beside it. Your own camera is a full page to the left.
// Screen shares stay a full page to the right. Swipe left reaches them only
// while someone is sharing. With nobody sharing, that swipe is the channel chat.
// A second swipe right, while your camera is showing, opens the channel list.

export type PipSpot = "top" | "left" | "right" | "bottom";

export type PhoneStyle = Record<string, string>;

export type PhonePlan = {
  /** duo: other people fill the call. Your camera is the page to the left. */
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

/** Your camera, one full page to the left of the call. Swipe right lands here. */
function selfPage(height: number): PhoneStyle {
  return {
    position: "absolute",
    left: "-100%",
    top: "0",
    width: "100%",
    height: `${Math.max(0, Math.round(height))}px`,
    zIndex: "1",
  };
}

/**
 * `keys` is visual order: other people first, you last.
 * `localKey` is your camera, when you are in the call.
 * With other people your camera is not on the call. It is the page to the left.
 */
export function phonePlan(args: {
  keys: string[];
  localKey?: string;
  landscape: boolean;
  width: number;
  height: number;
  pipSpot: PipSpot;
  pipWide: boolean;
  /** Cameras whose picture is taller than wide. Everyone else stays 16:9. */
  portraitKeys?: string[];
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
  const withOthers = Boolean(args.localKey && others.length > 0 && keys.includes(args.localKey));
  const parkSelf = () => {
    if (withOthers && args.localKey) places[args.localKey] = selfPage(args.height);
  };

  // Desktop cameras stay 16:9. A phone camera is one vertical tile of the
  // same height, in the same row. Two equal columns is the layout to avoid.
  const portraits = new Set(args.portraitKeys ?? []);
  const items = gridKeys.map((key) => ({ key, portrait: portraits.has(key) }));
  const stageW = Math.max(1, args.width);
  const stageH = Math.max(1, args.height);
  const ratio = (portrait: boolean) => (portrait ? 9 / 16 : 16 / 9);
  const rowHeight = (row: { portrait: boolean }[], maxH: number) => {
    const unit = row.reduce((sum, item) => sum + ratio(item.portrait), 0) || 1;
    return Math.max(0, Math.min(maxH, stageW / unit));
  };
  const unit = items.reduce((sum, item) => sum + ratio(item.portrait), 0) || 1;
  const oneRowH = Math.min(stageH, stageW / unit);
  const split = items.length > 2 && oneRowH < stageH * 0.34;
  const rows = split ? [items.slice(0, Math.ceil(items.length / 2)), items.slice(Math.ceil(items.length / 2))] : [items];
  const gap = split ? 8 : 0;
  const heights = rows.map((row) => rowHeight(row, (stageH - gap * (rows.length - 1)) / rows.length));
  const totalH = heights.reduce((sum, h) => sum + h, 0) + gap * (rows.length - 1);
  let top = Math.max(0, (stageH - totalH) / 2);
  rows.forEach((row, r) => {
    const h = heights[r];
    const rowW = h * row.reduce((sum, item) => sum + ratio(item.portrait), 0);
    let x = Math.max(0, (stageW - rowW) / 2);
    for (const item of row) {
      const w = h * ratio(item.portrait);
      places[item.key] = {
        position: "absolute",
        left: px(x),
        top: px(top),
        width: px(w),
        height: px(h),
        zIndex: "1",
      };
      x += w;
    }
    top += h + gap;
  });
  parkSelf();
  return { mode: withOthers ? "duo" : "stack", scroll: false, grid: {}, places };
}

/** your camera | the call | the share shelf | one share entered beside the person sharing it */
export type ShareView = "self" | "people" | "shelf" | "open";

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
 * Right from the people opens your camera, when that page exists.
 * Left from the people opens the shelf, when someone is sharing.
 * Left from your camera returns to the people.
 * Right from the shelf returns to the people.
 * Right from an entered share returns to the shelf. Left from the shelf does not enter.
 */
export function shareSwipeTarget(
  view: ShareView,
  dx: number,
  width: number,
  ends: { self?: boolean; shares?: boolean } = {},
): ShareView {
  const w = Math.max(1, width);
  if (Math.abs(dx) < Math.min(48, w * 0.2)) return view;
  if (dx > 0 && view === "people" && ends.self) return "self";
  if (dx < 0 && view === "people" && ends.shares) return "shelf";
  if (dx < 0 && view === "self") return "people";
  if (dx > 0 && view === "shelf") return "people";
  if (dx > 0 && view === "open") return "shelf";
  return view;
}
