// Phone videochat geometry. Desktop uses deskPlan.
// You alone fill the phone. With other people, two wide cameras stack full
// width. Everyone who does not fit there sits in a small row at the bottom.
// A wide camera stays 16:9. A phone camera stays vertical, including yours,
// so yours is the small tall tile. Screen shares stay a full page to the right.

export type PipSpot = "top" | "left" | "right" | "bottom";

export type PhoneStyle = Record<string, string>;

export type PhonePlan = {
  /** duo: wide cameras are the big stack. Your camera is in the small row. */
  mode: "solo" | "duo" | "stack";
  scroll: boolean;
  pipKey?: string;
  grid: PhoneStyle;
  places: Record<string, PhoneStyle>;
};

const full: PhoneStyle = { left: "0", top: "0", width: "100%", height: "100%", "z-index": "1" };

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

/**
 * `keys` is visual order: other people first, you last.
 * `localKey` is your camera, when you are in the call.
 * Two wide cameras stack full width. The rest share a small row underneath.
 * On an upright phone your own camera is vertical, so it stays in that small row.
 */
export function phonePlan(args: {
  keys: string[];
  localKey?: string;
  landscape: boolean;
  width: number;
  height: number;
  pipSpot: PipSpot;
  pipWide: boolean;
  /** Cameras whose picture is taller than wide, and people who joined from a phone. */
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

  const portraits = new Set(args.portraitKeys ?? []);

  // A phone held sideways is short and wide: everyone sits side by side in one balanced grid that uses the
  // whole width (a stack down the middle leaves the sides empty and the pictures tiny).
  if (args.landscape && n > 1) {
    const pad = 8;
    const gap = 8;
    const W = Math.max(1, args.width - pad * 2);
    const H = Math.max(1, args.height - pad * 2);
    // a balanced block (4 people are 2 by 2, never 1 by 4)
    const bestCols = Math.ceil(Math.sqrt(n));
    const grid = deskPlan({ keys, portraitKeys: [...portraits], width: W, height: H, cols: bestCols, gap });
    const placed: Record<string, PhoneStyle> = {};
    for (const [key, style] of Object.entries(grid)) {
      placed[key] = { ...style, left: px(parseFloat(style.left) + pad), top: px(parseFloat(style.top) + pad) };
    }
    return { mode: "stack", scroll: false, grid: {}, places: placed };
  }

  const items = keys.map((key) => ({
    key,
    // tall only when the caller says the picture in it is tall (measured from the real frame)
    portrait: portraits.has(key),
  }));
  const big: { key: string; portrait: boolean }[] = [];
  const small: { key: string; portrait: boolean }[] = [];
  for (const item of items) {
    if (!item.portrait && big.length < 2) big.push(item);
    else small.push(item);
  }

  const gap = 8;
  const pad = 8;
  const stageW = Math.max(1, args.width);
  const stageH = Math.max(1, args.height);
  const innerW = Math.max(1, stageW - pad * 2);
  const innerH = Math.max(1, stageH - pad * 2);
  const ratio = (portrait: boolean) => (portrait ? 9 / 16 : 16 / 9);
  const smallUnit = small.reduce((sum, item) => sum + ratio(item.portrait), 0);
  const smallGaps = gap * Math.max(0, small.length - 1);
  const bigGaps = gap * Math.max(0, big.length - 1);
  const groupGap = big.length && small.length ? gap * 2 : 0;
  let bigH = (innerW * 9) / 16;
  let smallH = big.length ? bigH * 0.42 : innerH;
  if (smallUnit > 0) smallH = Math.min(smallH, Math.max(0, (innerW - smallGaps) / smallUnit));
  let total = big.length * bigH + bigGaps + groupGap + (small.length ? smallH : 0);
  if (total > innerH && total > 0) {
    const scale = innerH / total;
    bigH *= scale;
    smallH *= scale;
    total *= scale;
  }
  let y = pad + Math.max(0, (innerH - total) / 2);
  big.forEach((item, i) => {
    const w = bigH * (16 / 9);
    places[item.key] = box(pad + (innerW - w) / 2, y, w, bigH);
    y += bigH;
    if (i < big.length - 1) y += gap;
  });
  if (groupGap) y += groupGap;
  if (small.length) {
    const rowW = smallH * smallUnit + smallGaps;
    let x = pad + Math.max(0, (innerW - rowW) / 2);
    for (const item of small) {
      const w = smallH * ratio(item.portrait);
      places[item.key] = box(x, y, w, smallH);
      x += w + gap;
    }
  }
  return { mode: big.length ? "duo" : "stack", scroll: false, grid: {}, places };
}

/**
 * Desktop grid. Every row shares one height. A desktop camera is 16:9.
 * A phone camera is the vertical tile of that same height. Rows wrap by
 * `cols`, and a shorter row is centred under the wider ones.
 */
export function deskPlan(args: {
  keys: string[];
  portraitKeys?: string[];
  width: number;
  height: number;
  cols: number;
  gap?: number;
}): Record<string, PhoneStyle> {
  const keys = args.keys.filter(Boolean);
  const places: Record<string, PhoneStyle> = {};
  if (keys.length === 0 || args.width <= 0 || args.height <= 0) return places;
  const portraits = new Set(args.portraitKeys ?? []);
  const cols = Math.max(1, Math.min(args.cols || 1, keys.length));
  const gap = args.gap ?? 10;
  const ratio = (key: string) => (portraits.has(key) ? 9 / 16 : 16 / 9);
  const rows: string[][] = [];
  for (let i = 0; i < keys.length; i += cols) rows.push(keys.slice(i, i + cols));
  const units = rows.map((row) => row.reduce((sum, key) => sum + ratio(key), 0));
  let tileH = Infinity;
  rows.forEach((row, i) => {
    const extra = gap * Math.max(0, row.length - 1);
    tileH = Math.min(tileH, Math.max(0, (args.width - extra) / units[i]));
  });
  const gapsY = gap * Math.max(0, rows.length - 1);
  if (rows.length * tileH + gapsY > args.height) {
    tileH = Math.max(0, (args.height - gapsY) / rows.length);
  }
  const blockH = rows.length * tileH + gapsY;
  let top = Math.max(0, (args.height - blockH) / 2);
  rows.forEach((row) => {
    const rowW = tileH * row.reduce((sum, key) => sum + ratio(key), 0) + gap * Math.max(0, row.length - 1);
    let x = Math.max(0, (args.width - rowW) / 2);
    for (const key of row) {
      const w = tileH * ratio(key);
      places[key] = box(x, top, w, tileH);
      x += w + gap;
    }
    top += tileH + gap;
  });
  return places;
}

/**
 * Broadcast layout (the Living Room): a permanent full-width panel on top (its
 * content - someone's Stream, if anyone has one on - is rendered separately,
 * not a tile), everyone's webcam a small row along the bottom - never the
 * adaptive grid, and never rearranged by who is talking.
 */
export function broadcastPlan(args: {
  keys: string[];
  width: number;
  height: number;
  /** the tile row sits this many px INTO the big panel's bottom edge
   * instead of right at it - Living Room's 3D floor, so the webcam zone
   * reads as part of the room instead of a strip stuck on below it. */
  overlap?: number;
  /** overrides the webcam row's default (64-96px) height clamp: the Living
   * Room's tiles can be bigger than the default row. */
  stripHeight?: number;
  /** caps the row's total width to this fraction of the panel's width -
   * Living Room's TV doesn't span the whole panel (there's wall on both
   * sides), so the webcam row should stay within the TV's own width
   * instead of the full panel. */
  rowWidthRatio?: number;
  /** the tile row's TOP edge, as a fraction (0 top, 1 bottom) of the
   * panel's own height - Living Room's actual TV bottom edge on screen,
   * projected live from the 3D camera (LivingRoomBroadcast.tsx). The TV's
   * rendered position moves with the container's aspect ratio, so a fixed
   * pixel `overlap` can drift the row up into the screen on a window size
   * it wasn't tuned against; this tracks the real edge instead and takes
   * priority over `overlap` when given. */
  tvBottomRatio?: number;
}): { places: Record<string, PhoneStyle>; big: PhoneStyle } {
  const keys = args.keys.filter(Boolean);
  const places: Record<string, PhoneStyle> = {};
  const gap = 10;
  const pad = 10;
  const innerW = Math.max(1, args.width - pad * 2);
  const innerH = Math.max(1, args.height - pad * 2);

  // The webcam strip stays small on purpose - the panel above it needs the real height.
  const stripH = keys.length ? (args.stripHeight ?? Math.min(96, Math.max(64, innerH * 0.14))) : 0;
  // The row's POSITION is still worked out as if space were reserved for
  // it below the panel (reservedH) - that's what keeps the row itself
  // exactly where and how big it already was. The panel's own RENDERED
  // height is separate: with overlap, the row floats on top of the panel
  // instead of sitting in reserved space below it, so the panel can use
  // the full height underneath - no black void left where that reserved
  // space used to be.
  const reservedH = Math.max(1, innerH - (keys.length ? stripH + gap : 0));
  const usingTvBottom = args.tvBottomRatio !== undefined;
  const bigAreaH = args.overlap || usingTvBottom ? innerH : reservedH;
  const big = box(pad, pad, innerW, bigAreaH);
  // When the tile row overlaps UP into the big panel's own rectangle, DOM
  // order alone isn't a reliable way to keep it on top - a WebGL canvas
  // (Living Room's 3D scene) can end up compositited above sibling DOM
  // content despite coming earlier in the markup. An explicit, lower
  // z-index on the big panel removes the ambiguity outright.
  if (args.overlap || usingTvBottom) big["z-index"] = "0";

  const n = keys.length;
  if (n > 0) {
    const rowMaxW = args.rowWidthRatio ? innerW * args.rowWidthRatio : innerW;
    const gapsX = gap * (n - 1);
    let cellW = Math.min((rowMaxW - gapsX) / n, (stripH * 16) / 9);
    cellW = Math.max(0, cellW);
    const rowW = cellW * n + gapsX;
    let x = pad + Math.max(0, (innerW - rowW) / 2);
    // tvBottomRatio pins the row to the TV's real on-screen bottom edge,
    // plus a small gap so the tiles read as sitting apart from the TV
    // (on the floor) instead of touching its frame - clamped so it can
    // never climb back above that edge (covering the screen) and never
    // run past the panel's own bottom either.
    const y = usingTvBottom
      ? pad + Math.min(Math.max(0, args.tvBottomRatio!) * innerH + gap, Math.max(0, innerH - stripH))
      : pad + reservedH + gap - (args.overlap ?? 0);
    for (const key of keys) {
      places[key] = box(x, y, cellW, stripH);
      x += cellW + gap;
    }
  }
  return { places, big };
}

/**
 * The Living Room on a phone. The desktop layout (broadcastPlan) lays the webcam row over the TV's floor
 * with a fixed 150px row and 53% of the width, which is far too small on a phone, and the phone's own
 * layout used to be drawn on top of the 3D room. Here the room (the TV) is one block and everyone's webcam
 * sits in its own block next to it, each tile the shape of its picture:
 *   upright:  the room across the top, everyone in two columns under it, rows added as people join (rows by
 *             columns): 2x2 (3 or 4 people), 3x2 (5 or 6), 4x2 (7 or 8); 1 person alone, 2 side by side
 *   sideways: the room fills the whole screen and everyone floats over it in one row on the floor, under
 *             the TV and never over it, every face the same size for 1 to 6 people (`tvBottom` is where the TV's bottom edge is, 0 to 1 of the height)
 */
export function livingPhonePlan(args: {
  keys: string[];
  portraitKeys?: string[];
  width: number;
  height: number;
  landscape: boolean;
  /** the TV's bottom edge as a fraction of the room's height, projected live from the 3D room */
  tvBottom?: number;
}): { places: Record<string, PhoneStyle>; big: PhoneStyle } {
  const pad = 8;
  const gap = 8;
  const W = Math.max(1, args.width - pad * 2);
  const H = Math.max(1, args.height - pad * 2);
  const keys = args.keys.filter(Boolean);
  const n = keys.length;
  const places: Record<string, PhoneStyle> = {};
  const place = (region: { x: number; y: number; w: number; h: number }, cols: number) => {
    if (n === 0 || region.w <= 0 || region.h <= 0) return;
    const grid = deskPlan({ keys, portraitKeys: args.portraitKeys, width: region.w, height: region.h, cols, gap });
    for (const key of keys) {
      const style = grid[key];
      if (style) places[key] = { ...style, left: px(parseFloat(style.left) + region.x), top: px(parseFloat(style.top) + region.y) };
    }
  };
  let big: PhoneStyle;
  if (!args.landscape) {
    // the room is about as wide as it is tall (its TV needs that to fit); the rest of the height is for faces
    const roomH = Math.min(n ? H * 0.52 : H, W / 1.45);
    big = box(pad, pad, W, roomH);
    const region = { x: pad, y: pad + roomH + gap, w: W, h: Math.max(0, H - roomH - gap) };
    // always two columns; rows are added as people join (rows by columns: 2x2, 3x2, 4x2)
    place(region, n <= 1 ? 1 : 2);
  } else {
    // the room fills the whole screen, edge to edge
    big = box(0, 0, args.width, args.height);
    if (n > 0) {
      // one row on the floor, under the TV: as tall as the floor allows, shrunk to fit the width
      const floorTop = Math.min(1, Math.max(0, args.tvBottom ?? 0.72)) * args.height + gap;
      const floorH = Math.max(24, args.height - floorTop - pad);
      const ratios = keys.map((key) => (args.portraitKeys?.includes(key) ? 9 / 16 : 16 / 9));
      const sum = ratios.reduce((a, b) => a + b, 0);
      // The faces keep ONE size however many are there: sized for a full row of 6, so nobody's picture
      // shrinks when more people join (up to 6; with more than 6 the row has to shrink to fit).
      const slots = Math.max(n, 6);
      const sizedFor = sum + (slots - n) * (16 / 9);
      const h = Math.max(16, Math.min(150, floorH, (W - gap * (slots - 1)) / sizedFor));
      const rowW = h * sum + gap * (n - 1);
      let x = pad + Math.max(0, (W - rowW) / 2);
      keys.forEach((key, i) => {
        places[key] = box(x, floorTop, h * ratios[i], h);
        x += h * ratios[i] + gap;
      });
    }
  }
  big["z-index"] = "0";
  return { places, big };
}

/**
 * Experiment (sideways Living Room): the TV is scaled up until it almost touches the top and bottom edges and sits on
 * the left; everyone's webcam stands in ONE column on the right (1 to 6 people), never over the TV. `tvRight` is the TV's right edge as
 * a fraction of the width (projected live from the 3D room).
 */
export function livingSidePlan(args: {
  keys: string[];
  portraitKeys?: string[];
  width: number;
  height: number;
  tvRight: number;
}): { places: Record<string, PhoneStyle>; big: PhoneStyle } {
  const pad = 8;
  const gap = 8;
  const keys = args.keys.filter(Boolean);
  const n = keys.length;
  const places: Record<string, PhoneStyle> = {};
  const big = box(0, 0, args.width, args.height);
  big["z-index"] = "0";
  if (n > 0) {
    const x0 = Math.min(1, Math.max(0, args.tvRight)) * args.width + gap;
    const region = { x: x0, y: pad, w: Math.max(0, args.width - x0 - pad), h: Math.max(0, args.height - pad * 2) };
    if (region.w > 0 && region.h > 0) {
      // always ONE column, 1 to 6 people. Every face is the same size, sized for a full column of 6 (more than 6
      // shrinks to fit), so nobody's picture changes size as people join; the column is centred in its space.
      const slots = Math.max(n, 6);
      const h = Math.max(16, Math.min((region.h - gap * (slots - 1)) / slots, (region.w * 9) / 16));
      const heights = keys.map(() => h);
      const widths = keys.map((key) => h * (args.portraitKeys?.includes(key) ? 9 / 16 : 16 / 9));
      const total = heights.reduce((x, y) => x + y, 0) + gap * (n - 1);
      let y = region.y + Math.max(0, (region.h - total) / 2);
      keys.forEach((key, i) => {
        places[key] = box(region.x + Math.max(0, (region.w - widths[i]) / 2), y, widths[i], heights[i]);
        y += heights[i] + gap;
      });
    }
  }
  return { places, big };
}

function box(x: number, y: number, width: number, height: number): PhoneStyle {
  return {
    position: "absolute",
    left: px(x),
    top: px(y),
    width: px(width),
    height: px(height),
    "z-index": "1",
  };
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
    "z-index": "1",
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
