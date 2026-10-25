// Darkwood Room: a plain CSS 3D room where everyone is their own webcam on a
// diamond (or hexagon) plate, walking around together.
//
// Opened from a Darkwood Node tile's Room side (room.html?s=<server>&c=<tile>),
// so it shares the app's Firebase login. /api/dh-token gives a LiveKit pass
// for the tile's room ("dh-<server>-<tile>--room", apart from the tile's
// videochat). Each person publishes their webcam, and sends where they stand,
// look, which shape they wear and where their face is in the picture as small
// LiveKit data messages ("pose"). Face tracking runs on the sender only.

import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { LocalVideoTrack, Room, RoomEvent, Track } from "livekit-client";

import { auth, db } from "../firebase";
import { SOURCES, failedChannels, loadChannels, playChannel } from "./tv";

// ---- room size, matching room.html (px, 100 px = 1 m)
const W = 600, D = 600, H = 300;
const EYE = 160;    // eye height above the floor, standing...
const SIT_EYE = 110; // ...and sitting on a chair
const MARGIN = 30;  // how close you can get to a wall
const SPEED = 180;  // px per second
const LOOK = 0.15;  // degrees per px of mouse movement
const PLATE_H = 60; // a plate is 0.6 m tall in the room
const BEHIND = 200; // third person: the camera sits 2 m behind you...
const ABOVE = 40;   // ...and 0.4 m higher
const EYE_Y = H / 2 - EYE; // css y points down; the room's middle is 0

const view = document.getElementById("view");
const world = document.getElementById("world");
const statusBox = document.getElementById("status");
const camBtn = document.getElementById("cam");
const shapeBtn = document.getElementById("shape");
const povBtn = document.getElementById("pov");
const fovSlider = document.querySelector("#fov input");
const fovText = document.querySelector("#fov output");

const remember = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const recall = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function setStatus(text, problem = false, link) {
  statusBox.classList.toggle("problem", problem);
  statusBox.textContent = text;
  if (link) {
    const a = document.createElement("a");
    a.href = link.href;
    a.target = "_top";
    a.textContent = link.text;
    statusBox.append(document.createElement("br"), a);
  }
}

// ---- Matrix rain on every wall, made once; CSS animates it (room.html .drop)
const GLYPHS = "ｦｱｳｴｵｶｷｹｺｻｼｽｾｿﾀﾂﾃﾅﾆﾇﾈﾊﾋﾎﾏﾐﾑﾒﾓﾔﾕﾗﾘﾜ0123456789Z:.=*+-<>¦";
const COLUMN = 12; // px, one character wide
function makeRain() {
  const pick = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
  for (const wall of document.querySelectorAll(".wall")) {
    const columns = Math.floor(wall.offsetWidth / COLUMN);
    for (let i = 0; i < columns; i++) {
      if (Math.random() < 0.25) continue; // a few gaps, like the film
      const drop = document.createElement("div");
      drop.className = "drop";
      const length = 6 + Math.floor(Math.random() * 15); // at most 240 px: fits the 300 px wall
      drop.textContent = Array.from({ length }, pick).join("\n");
      const t = 4 + Math.random() * 8; // seconds to fall the wall
      drop.style.left = `${i * COLUMN}px`;
      drop.style.setProperty("--t", `${t.toFixed(2)}s`);
      drop.style.setProperty("--delay", `${(-Math.random() * t).toFixed(2)}s`); // already mid-fall
      drop.style.setProperty("--travel", `${H - length * 12}px`); // its bottom reaches the floor
      drop.style.setProperty("--o", (0.45 + Math.random() * 0.55).toFixed(2));
      wall.append(drop);
    }
  }
}
makeRain();

const SCREEN_X = 150; // each screen's centre, left or right of the wall's middle

// ---- chairs (Kaalob's drawing): a wide armless box seat, and a back that
// is thick at the seat and thin at the top, leaning back, its rear edge
// straight down to the floor. Built from flat CSS faces like the room.
// Chair space: origin on the floor at its middle, y up is negative (CSS),
// the seat's front edge toward -z.
const CHAIR = {
  w: 90,        // width
  d: 85,        // depth, front edge to the back's rear
  seat: 38,     // seat height
  tall: 90,     // top of the back
  backTop: 10,  // the back's thickness at the top...
  backBase: 27, // ...and where it meets the seat
};
function chairFace(chair, w, h, transform, cls = "", clip = "") {
  const f = document.createElement("div");
  f.className = `chair-face ${cls}`;
  f.style.width = `${w}px`;
  f.style.height = `${h}px`;
  f.style.transform = transform;
  if (clip) f.style.clipPath = clip;
  chair.append(f);
}
function makeChair(x, z, turn = 0) {
  const { w, d, seat, tall, backTop, backBase } = CHAIR;
  const chair = document.createElement("div");
  chair.className = "chair";
  chair.style.transform = `translate3d(${x}px, ${H / 2}px, ${z}px) rotateY(${turn}deg)`;
  const seatDepth = d - backBase; // seat top, front edge to the back
  // A face starts flat at its corner (0,0,0), facing +z; each is moved and
  // turned into place. rotateY(90) faces +x, rotateX(90) faces up.
  chairFace(chair, w, tall, `translate3d(${-w / 2}px, ${-tall}px, ${d / 2}px)`, "rear");
  chairFace(chair, w, seat, `translate3d(${w / 2}px, ${-seat}px, ${-d / 2}px) rotateY(180deg)`, "front");
  chairFace(chair, w, seatDepth, `translate3d(${-w / 2}px, ${-seat}px, ${-d / 2}px) rotateX(90deg)`, "top");
  chairFace(chair, w, backTop, `translate3d(${-w / 2}px, ${-tall}px, ${d / 2 - backTop}px) rotateX(90deg)`, "top");
  // the back's slanted front, from the seat up to the top
  const rise = tall - seat, lean = backBase - backTop;
  chairFace(
    chair,
    w,
    Math.hypot(rise, lean),
    `translate3d(${w / 2}px, ${-tall}px, ${d / 2 - backTop}px) rotateY(180deg) rotateX(${Math.atan2(lean, rise)}rad)`,
    "front",
  );
  // the two covered sides: the drawn side profile, painted as a picture on
  // a d x tall panel (filled like the other faces, outlined in glowing
  // green; outside the shape the picture is see-through). Not cut out with
  // clip-path: a cut-out panel was left behind when the chair turned, and
  // some went missing, so the sides are plain panels like the rest.
  const profile = [[d, tall], [d, tall - seat], [backBase, tall - seat], [backTop, 0], [0, 0], [0, tall]];
  const panel = `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${d}' height='${tall}'><polygon points='${profile.join(" ")}' fill='#072414' stroke='#23ff9a' stroke-opacity='.85' stroke-width='2'/></svg>`,
  )}")`;
  for (const sx of [w / 2, -w / 2]) {
    chairFace(chair, d, tall, `translate3d(${sx}px, ${-tall}px, ${d / 2}px) rotateY(90deg)`, "flank"); // not "side": that class is the room's side walls
    chair.lastChild.style.backgroundImage = panel;
  }
  world.append(chair);
  const c = { x, z, el: chair, turn: 0, turnAt: 0, half: 0, halfZ: 0 };
  turnChair(c, turn);
  return c;
}
/** Turns a chair to face `turn` degrees (0 = the front wall), a quarter at a time. */
function turnChair(c, turn) {
  c.turn = ((turn % 360) + 360) % 360;
  c.el.style.transform = `translate3d(${c.x}px, ${H / 2}px, ${c.z}px) rotateY(${c.turn}deg)`;
  // what blocks walking: its width and depth swap when it is side-on
  const sideOn = c.turn % 180 !== 0;
  c.half = (sideOn ? CHAIR.d : CHAIR.w) / 2;
  c.halfZ = (sideOn ? CHAIR.w : CHAIR.d) / 2;
}
// one chair per screen, 1.5 m in front of it and facing it: screens 1 and 2
// on the front wall, 3 and 4 on the back wall (turned around)
const CHAIRS = [
  makeChair(-SCREEN_X, -D / 4),
  makeChair(SCREEN_X, -D / 4),
  makeChair(SCREEN_X, D / 4, 180),
  makeChair(-SCREEN_X, D / 4, 180),
];
// ---- the table: dining height, in the middle of the room between the two
// rows of chairs, its long side left to right (parallel to the TV walls),
// long enough to reach past both chairs of each row (Kaalob's floor plan).
// Same look as the chairs: a top slab on four square legs.
const TABLE = { w: 400, d: 80, tall: 75, slab: 5, leg: 6 };
/** A box of CSS faces in `parent`: x0..x1 left to right, z0..z1 front to back,
 *  from `top` (px above the floor) down `h` px. No bottom face. */
function boxFaces(parent, x0, x1, z0, z1, top, h, topCls = "top") {
  const y = -top, sx = x1 - x0, sz = z1 - z0;
  chairFace(parent, sx, h, `translate3d(${x0}px, ${y}px, ${z1}px)`);
  chairFace(parent, sx, h, `translate3d(${x1}px, ${y}px, ${z0}px) rotateY(180deg)`);
  chairFace(parent, sz, h, `translate3d(${x1}px, ${y}px, ${z1}px) rotateY(90deg)`);
  chairFace(parent, sz, h, `translate3d(${x0}px, ${y}px, ${z0}px) rotateY(-90deg)`);
  chairFace(parent, sx, sz, `translate3d(${x0}px, ${y}px, ${z0}px) rotateX(90deg)`, topCls);
}
function makeTable() {
  const { w, d, tall, slab, leg } = TABLE;
  const table = document.createElement("div");
  table.className = "chair"; // same 3D holder as a chair
  table.style.transform = `translate3d(0px, ${H / 2}px, 0px)`;
  boxFaces(table, -w / 2, w / 2, -d / 2, d / 2, tall, slab);
  const lx = w / 2 - leg - 4, lz = d / 2 - leg - 4; // legs set in a little
  // a leg at each corner and a pair in the middle of the long sides
  for (const [x, z] of [[-lx, -lz], [lx, -lz], [-lx, lz], [lx, lz], [0, -lz], [0, lz]]) {
    boxFaces(table, x - leg / 2, x + leg / 2, z - leg / 2, z + leg / 2, tall - slab, tall - slab, "");
  }
  world.append(table);
  return { x: 0, z: 0, half: w / 2, halfZ: d / 2 };
}
const THE_TABLE = makeTable();

const CHAIR_GAP = 18; // how close you can walk to a chair (or the table)
const inChair = (x, z) =>
  [...CHAIRS, THE_TABLE].some((c) => Math.abs(x - c.x) < c.half + CHAIR_GAP && Math.abs(z - c.z) < c.halfZ + CHAIR_GAP);

// ---- four monitors, two on each of the opposite walls, at eye level
// Screens 1 and 2 hang side by side on the front wall, 3 and 4 on the back
// wall, numbered left to right as you face each wall. They stand on their
// own just off the wall, never inside it: a wall is drawn as one flat
// 600 x 300 picture (for the rain), which blurred a 1080p share into
// blocks. On its own the video keeps its full resolution. Sharing
// publishes your screen to the room as a track named "monitor-<n>";
// everyone shows it on that monitor. One person per monitor.
const SCREENS = [
  // front wall (-z), facing it your left is -x
  { id: 1, x: -SCREEN_X, z: -D / 2 + 2, place: `translate3d(${-SCREEN_X}px, 0, ${-D / 2 + 2}px)` },
  { id: 2, x: SCREEN_X, z: -D / 2 + 2, place: `translate3d(${SCREEN_X}px, 0, ${-D / 2 + 2}px)` },
  // back wall (+z), facing it your left is +x
  { id: 3, x: SCREEN_X, z: D / 2 - 2, place: `translate3d(${SCREEN_X}px, 0, ${D / 2 - 2}px) rotateY(180deg)` },
  { id: 4, x: -SCREEN_X, z: D / 2 - 2, place: `translate3d(${-SCREEN_X}px, 0, ${D / 2 - 2}px) rotateY(180deg)` },
].map((s) => {
  const el = document.createElement("div");
  el.className = "monitor";
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  const idle = document.createElement("div");
  idle.className = "idle";
  idle.textContent = `SCREEN ${s.id}\n${s.id} share · T TV`;
  const label = document.createElement("div");
  label.className = "label";
  // TV plays in its own <video> (hls.js feeds it), so a share never fights it
  const tvVideo = document.createElement("video");
  tvVideo.className = "tv-video";
  tvVideo.autoplay = true;
  tvVideo.muted = true;
  tvVideo.playsInline = true;
  el.append(video, tvVideo, idle, label);
  el.style.transform = s.place;
  world.append(el);
  return { ...s, el, video, tvVideo, label, owner: null, mine: null, tv: null, tvAt: 0, tvPlayer: null, tvPlaying: null };
});
const CAN_SHARE = Boolean(navigator.mediaDevices?.getDisplayMedia);
const screenOfTrack = (name) => SCREENS.find((s) => name === `monitor-${s.id}`);

function showOnScreen(screen, track, p) {
  screen.owner = p.identity;
  track.attach(screen.video);
  screen.el.classList.add("on");
  screen.label.textContent = `Screen ${screen.id} · ${people.get(p.identity)?.name || p.name || "someone"}`;
  updateShareButtons();
  refreshTv(screen);
}
function clearScreen(screen) {
  if (!big.hidden && bigScreen === screen) closeBig();
  screen.owner = null;
  screen.video.srcObject = null;
  screen.el.classList.remove("on");
  screen.label.textContent = "";
  updateShareButtons();
  refreshTv(screen); // a TV channel under the share comes back
}
function clearScreensOf(identity) {
  for (const s of SCREENS) if (s.owner === identity) clearScreen(s);
}

async function toggleShare(screen) {
  if (screen.mine) return stopShare(screen);
  if (!CAN_SHARE || !room) return;
  if (screen.owner) {
    setStatus(`Screen ${screen.id} is in use. Try the other one.`);
    setTimeout(updateCount, 3000);
    return;
  }
  // one screen at a time: sharing to the other monitor moves it
  for (const s of SCREENS) if (s.mine) await stopShare(s);
  let media;
  try {
    // 1080p: text stays readable on the wall and in the big view (F)
    media = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 10, max: 15 } },
      audio: false,
    });
  } catch {
    return; // picker closed
  }
  const track = media.getVideoTracks()[0];
  track.contentHint = "detail"; // keep text sharp
  const local = new LocalVideoTrack(track, undefined, true);
  screen.mine = local;
  screen.owner = room.localParticipant.identity;
  screen.video.srcObject = new MediaStream([track]);
  screen.el.classList.add("on");
  screen.label.textContent = `Screen ${screen.id} · you`;
  refreshTv(screen);
  track.addEventListener("ended", () => stopShare(screen)); // the browser's own Stop sharing
  updateShareButtons();
  try {
    await room.localParticipant.publishTrack(local, {
      name: `monitor-${screen.id}`,
      source: Track.Source.ScreenShare,
      simulcast: false,
      // H.264: the graphics card encodes it (a game keeps the CPU busy).
      // A home upload is ~2 Mbps for everything you send, so the share gets
      // 1.5 Mbps at 10 frames a second: about twice the detail per frame
      // of 15 fps, which is what keeps text readable.
      videoCodec: "h264",
      videoEncoding: { maxBitrate: 1_500_000, maxFramerate: 10 },
      // short on upload: keep the 1080p sharpness, drop frames instead
      degradationPreference: "maintain-resolution",
    });
  } catch (err) {
    console.warn("[room] could not share the screen:", err);
    await stopShare(screen);
  }
}
async function stopShare(screen) {
  const local = screen.mine;
  if (!local) return;
  screen.mine = null;
  await room?.localParticipant.unpublishTrack(local, false).catch(() => {});
  local.mediaStreamTrack.stop();
  clearScreen(screen);
}

// ---- big view: F opens the screen you face full size, F or Esc closes
const big = document.getElementById("bigscreen");
const bigVideo = big.querySelector("video");
const bigCams = document.getElementById("bigcams");
let bigScreen = null;
let bigPlayer = null; // TV in the big view: its own player, captions on
/** Of these screens, the one nearest the middle of your view. */
function nearestInView(screens) {
  const a = (me.yaw * Math.PI) / 180;
  const fx = Math.sin(a), fz = -Math.cos(a); // the way you look, on the floor
  let best = null, bestCos = -Infinity;
  for (const s of screens) {
    const dx = s.x - me.x, dz = s.z - me.z;
    const cos = (dx * fx + dz * fz) / (Math.hypot(dx, dz) || 1);
    if (cos > bestCos) { bestCos = cos; best = s; }
  }
  return best;
}
// F: the showing screen (a share or TV) you look at most directly
function facedScreen() {
  return nearestInView(SCREENS.filter((s) => s.el.classList.contains("on") || s.el.classList.contains("tv")));
}
function openBig(screen) {
  if (!screen) return;
  bigScreen = screen;
  if (screen.owner) bigVideo.srcObject = screen.video.srcObject;
  else if (screen.tv) bigPlayer = playChannel(bigVideo, screen.tv.url, { muted: !tvSound });
  big.hidden = false;
  document.body.classList.add("big");
  if (document.pointerLockElement) document.exitPointerLock();
  syncBigCams();
  bigTimer = setInterval(syncBigCams, 1000); // people come, go, turn cameras on and off
}
function closeBig() {
  big.hidden = true;
  document.body.classList.remove("big");
  bigPlayer?.destroy();
  bigPlayer = null;
  bigScreen = null;
  bigVideo.srcObject = null;
  clearInterval(bigTimer);
  for (const tile of bigTiles.values()) tile.video.srcObject = null;
  bigTiles.clear();
  bigCams.replaceChildren();
}

// Everyone in the room under the big screen (you first): their whole
// webcam picture, or black with their username while it is off.
let bigTimer = 0;
const bigTiles = new Map(); // "me" or identity -> { el, video, center, who }
function syncBigCams() {
  const everyone = [
    ["me", mine.video.srcObject, Boolean(stream), mine.name || "you"],
    ...[...people.entries()].map(([id, p]) => [id, p.video.srcObject, p.el.classList.contains("live"), p.name || "someone"]),
  ];
  const keep = new Set(everyone.map(([id]) => id));
  for (const [id, tile] of bigTiles) {
    if (!keep.has(id)) { tile.video.srcObject = null; tile.el.remove(); bigTiles.delete(id); }
  }
  for (const [id, src, live, name] of everyone) {
    let tile = bigTiles.get(id);
    if (!tile) {
      const el = document.createElement("div");
      el.className = "call-tile";
      const video = document.createElement("video");
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      const center = document.createElement("div");
      center.className = "name";
      const who = document.createElement("div");
      who.className = "who";
      el.append(video, center, who);
      tile = { el, video, center, who };
      bigTiles.set(id, tile);
    }
    if (tile.video.srcObject !== src) tile.video.srcObject = src ?? null;
    tile.el.classList.toggle("live", Boolean(live && src));
    tile.center.textContent = name;
    tile.who.textContent = name;
    bigCams.append(tile.el); // keeps the order: you, then everyone else
  }
}
// Leaving the big view puts the mouse straight back on looking around.
// (The browser refuses this on Esc, which never counts as a user action:
// then a click in the room takes the mouse back, as always.)
function leaveBig() {
  closeBig();
  try {
    view.requestPointerLock()?.catch?.(() => {});
  } catch {
    /* refused: a click in the room takes it */
  }
}
big.addEventListener("click", leaveBig);
addEventListener("keydown", (e) => {
  if (e.code === "KeyF" && !e.repeat) big.hidden ? openBig(facedScreen()) : leaveBig();
  if (e.code === "Escape" && !big.hidden) leaveBig();
});

// ---- TV on a monitor: same channel for everyone, played by each browser
// The channel (name + stream address) travels as a small reliable "tv"
// message; newer wins (at = when it was chosen). Newcomers are told by
// everyone (ParticipantConnected). A share on the same monitor covers the
// TV; the channel stops loading meanwhile and comes back after.
let tvSound = false; // TV sound is yours alone (M), off to start
function refreshTv(screen) {
  const want = screen.tv && !screen.owner ? screen.tv.url : null;
  if (screen.tvPlaying !== want) {
    screen.tvPlayer?.destroy();
    screen.tvPlayer = null;
    screen.tvPlaying = want;
    screen.el.classList.remove("tv-failed");
    if (want) {
      screen.tvPlayer = playChannel(screen.tvVideo, want, {
        muted: !tvSound,
        onFail: (why) => {
          console.warn("[room] TV channel will not play here:", screen.tv?.name, why);
          screen.el.classList.add("tv-failed");
          if (!screen.owner && screen.tv) screen.label.textContent = `TV · ${screen.tv.name} · can't play here, pick another (T)`;
        },
      });
    }
  }
  screen.el.classList.toggle("tv", Boolean(want));
  if (!screen.owner && !screen.el.classList.contains("tv-failed")) {
    screen.label.textContent = screen.tv ? `TV · ${screen.tv.name}` : "";
  }
  // the big view follows a channel change on the screen it shows
  if (!big.hidden && bigScreen === screen && !screen.owner && bigPlayer && bigPlayer.url !== want) {
    closeBig();
    if (want) openBig(screen);
  }
}
function setTv(screen, tv, at = Date.now(), send = true) {
  if (at < screen.tvAt) return;
  screen.tv = tv;
  screen.tvAt = at;
  refreshTv(screen);
  if (send) sendTv(screen);
}
function sendTv(screen, to) {
  if (!room || room.state !== "connected") return;
  const msg = JSON.stringify({ screen: screen.id, tv: screen.tv, at: screen.tvAt });
  room.localParticipant
    .publishData(new TextEncoder().encode(msg), { reliable: true, topic: "tv", destinationIdentities: to })
    .catch(() => {});
}
function onTv(data) {
  let msg;
  try {
    msg = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return;
  }
  const screen = SCREENS.find((s) => s.id === msg.screen);
  if (!screen) return;
  const tv =
    msg.tv && typeof msg.tv.url === "string" && /^https:\/\//.test(msg.tv.url)
      ? { name: String(msg.tv.name || "TV").slice(0, 80), url: msg.tv.url }
      : null;
  if (msg.tv && !tv) return;
  setTv(screen, tv, Number(msg.at) || 0, false);
}
function toggleTvSound() {
  tvSound = !tvSound;
  for (const s of SCREENS) s.tvVideo.muted = !tvSound;
  if (bigPlayer) bigVideo.muted = !tvSound;
  setStatus(tvSound ? "TV sound on (M)" : "TV sound off (M)");
  setTimeout(updateCount, 2000);
}

// ---- the channel picker (T): for the monitor you face
const picker = document.getElementById("tvpicker");
const pickerTitle = picker.querySelector(".title");
const pickerTabs = picker.querySelector(".tabs");
const pickerSearch = picker.querySelector("input");
const pickerList = picker.querySelector(".list");
let pickerScreen = null;
let pickerSource = "free";
// T: whichever screen you look at most directly, showing or not
const facingScreen = () => nearestInView(SCREENS);
function openPicker(screen) {
  pickerScreen = screen;
  pickerTitle.textContent = `TV on Screen ${screen.id}${screen.tv ? " · now: " + screen.tv.name : ""}`;
  picker.hidden = false;
  if (document.pointerLockElement) document.exitPointerLock();
  pickerSearch.value = "";
  pickerSearch.focus();
  showSource(pickerSource);
}
function closePicker(relock) {
  picker.hidden = true;
  pickerScreen = null;
  if (relock) {
    try {
      view.requestPointerLock()?.catch?.(() => {});
    } catch {
      /* refused: a click in the room takes it */
    }
  }
}
pickerTabs.replaceChildren(
  ...SOURCES.map((src) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = src.name;
    b.dataset.source = src.id;
    b.addEventListener("click", () => showSource(src.id));
    return b;
  }),
);
let pickerChannels = [];
async function showSource(id) {
  pickerSource = id;
  for (const b of pickerTabs.children) b.setAttribute("aria-pressed", String(b.dataset.source === id));
  pickerList.textContent = "Loading channels…";
  try {
    pickerChannels = await loadChannels(id);
  } catch {
    pickerList.textContent = "Could not load the channel list. Try again in a moment.";
    return;
  }
  if (pickerSource === id) renderChannels();
}
const LIST_MAX = 300; // more than this: type to narrow it down
const isUs = (c) => /^(usa|united states)/i.test(c.group);
function renderChannels() {
  const q = pickerSearch.value.trim().toLowerCase();
  const found = pickerChannels.filter((c) => !q || c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
  // the USA first, and channels that did not play here last
  const failed = failedChannels();
  found.sort((a, b) => Number(isUs(b)) - Number(isUs(a)) || Number(failed.has(a.url)) - Number(failed.has(b.url)));
  const rows = found.slice(0, LIST_MAX).map((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "channel";
    if (pickerScreen?.tv?.url === c.url) b.classList.add("now");
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    if (c.logo.startsWith("https://")) img.src = c.logo;
    img.onerror = () => (img.style.visibility = "hidden");
    const name = document.createElement("span");
    name.textContent = c.name;
    const group = document.createElement("small");
    group.textContent = failed.has(c.url) ? `${c.group} · didn't play here` : c.group;
    if (failed.has(c.url)) b.classList.add("bad");
    b.append(img, name, group);
    b.addEventListener("click", () => {
      if (pickerScreen) setTv(pickerScreen, { name: c.name, url: c.url });
      closePicker(true);
    });
    return b;
  });
  pickerList.replaceChildren(...rows);
  if (!rows.length) pickerList.textContent = "No channel by that name.";
  else if (found.length > LIST_MAX) {
    const more = document.createElement("p");
    more.textContent = `${found.length - LIST_MAX} more: type to find them`;
    pickerList.append(more);
  }
}
pickerSearch.addEventListener("input", renderChannels);
picker.querySelector(".off").addEventListener("click", () => {
  if (pickerScreen) setTv(pickerScreen, null);
  closePicker(true);
});
picker.querySelector(".close").addEventListener("click", () => closePicker(true));
// typing in the picker never walks or toggles anything in the room
picker.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.code === "Escape") closePicker(false);
});
addEventListener("keydown", (e) => {
  if (e.repeat || !picker.hidden || !big.hidden) return;
  if (e.code === "KeyT") openPicker(facingScreen());
  if (e.code === "KeyM") toggleTvSound();
});

// ---- turning chairs (R): the chair you look at turns a quarter, for
// everyone. Like TV, a small reliable "chair" message, newest wins, and
// newcomers are told the turns on arrival.
const CHAIR_REACH = 300; // you can turn a chair up to 3 m away
function chairInView() {
  const near = CHAIRS.filter((c) => Math.hypot(c.x - me.x, c.z - me.z) < CHAIR_REACH);
  return near.length ? nearestInView(near) : null;
}
function turnChairBy(c) {
  turnChair(c, c.turn + 90);
  c.turnAt = Date.now();
  sendChair(c);
  if (CHAIRS[me.seat] === c) placeSeated(); // you turn with your chair
}
function sendChair(c, to) {
  if (!room || room.state !== "connected") return;
  const msg = JSON.stringify({ chair: CHAIRS.indexOf(c), turn: c.turn, at: c.turnAt });
  room.localParticipant
    .publishData(new TextEncoder().encode(msg), { reliable: true, topic: "chair", destinationIdentities: to })
    .catch(() => {});
}
function onChair(data) {
  let msg;
  try {
    msg = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return;
  }
  const c = CHAIRS[msg.chair];
  const at = Number(msg.at) || 0;
  if (!c || at <= c.turnAt || ![0, 90, 180, 270].includes(msg.turn)) return;
  turnChair(c, msg.turn);
  c.turnAt = at;
  if (CHAIRS[me.seat] === c) placeSeated();
}
// ---- sitting (E): your plate sits on the chair you look at, facing the
// way the chair faces; walking (or E again) stands you up in front of it.
// Others see it from your pose (eye height and seat). One person a chair.
const SEAT_Z = -6; // where you sit, from the chair's middle (toward its front)
/** A point in a chair's own space (lz toward its back) on the floor. */
function chairPoint(c, lz) {
  const t = (c.turn * Math.PI) / 180;
  return { x: c.x + lz * Math.sin(t), z: c.z + lz * Math.cos(t) };
}
function seatTaken(i) {
  for (const person of people.values()) if (person.seat === i) return true;
  return false;
}
/**
 * Which way your plate faces: where you look; seated, it follows your look
 * only up to 45 degrees left or right of the way the chair faces.
 */
const SEAT_TURN = 45;
function bodyYaw() {
  if (me.seat < 0) return me.yaw;
  const chairYaw = -CHAIRS[me.seat].turn;
  const off = ((((me.yaw - chairYaw) % 360) + 540) % 360) - 180; // -180..180
  return chairYaw + clamp(off, -SEAT_TURN, SEAT_TURN);
}
function placeSeated() {
  const c = CHAIRS[me.seat];
  const p = chairPoint(c, SEAT_Z);
  me.x = p.x;
  me.z = p.z;
  me.yaw = -c.turn; // the way the chair faces
  me.eye = SIT_EYE;
  draw();
  sendPose(true);
}
function sitDown(c) {
  const i = CHAIRS.indexOf(c);
  if (seatTaken(i)) {
    setStatus("Someone is sitting there");
    setTimeout(updateCount, 2500);
    return;
  }
  me.seat = i;
  me.pitch = 0;
  placeSeated();
  updateSitButton();
}
function standUp() {
  const c = CHAIRS[me.seat];
  me.seat = -1;
  me.eye = EYE;
  // step out in front of the chair
  const p = chairPoint(c, -CHAIR.d / 2 - 30);
  me.x = clamp(p.x, -W / 2 + MARGIN, W / 2 - MARGIN);
  me.z = clamp(p.z, -D / 2 + MARGIN, D / 2 - MARGIN);
  draw();
  sendPose(true);
  updateSitButton();
}
function toggleSit() {
  if (me.seat >= 0) return standUp();
  const c = chairInView();
  if (c) sitDown(c);
}
const sitBtn = document.createElement("button");
sitBtn.type = "button";
sitBtn.addEventListener("click", toggleSit);
document.getElementById("bar").append(sitBtn);
function updateSitButton() {
  sitBtn.textContent = me.seat >= 0 ? "Stand up (E)" : "Sit (E)";
  sitBtn.title = me.seat >= 0 ? "Stand up (walking stands you up too)" : "Sit on the chair you look at";
}
addEventListener("keydown", (e) => {
  if (e.repeat || !picker.hidden || !big.hidden || e.code !== "KeyE") return;
  toggleSit();
});

const chairBtn = document.createElement("button");
chairBtn.type = "button";
chairBtn.textContent = "Turn chair (R)";
chairBtn.title = "Turn the chair you look at by 90 degrees";
chairBtn.addEventListener("click", () => {
  const c = chairInView();
  if (c) turnChairBy(c);
});
document.getElementById("bar").append(chairBtn);
addEventListener("keydown", (e) => {
  if (e.repeat || !picker.hidden || !big.hidden || e.code !== "KeyR") return;
  const c = chairInView();
  if (c) turnChairBy(c);
});

const shareBtns = SCREENS.map((s) => {
  const b = document.createElement("button");
  b.type = "button";
  b.addEventListener("click", () => toggleShare(s));
  if (CAN_SHARE) document.getElementById("bar").append(b);
  return b;
});
function updateShareButtons() {
  SCREENS.forEach((s, i) => {
    const b = shareBtns[i];
    b.textContent = s.mine ? `Stop ${s.id}` : `Share ${s.id}`;
    b.title = s.mine ? `Stop sharing on screen ${s.id} (key ${s.id})` : `Share your screen to screen ${s.id} (key ${s.id})`;
    b.setAttribute("aria-pressed", String(Boolean(s.mine)));
    b.disabled = Boolean(s.owner && !s.mine);
  });
}
updateShareButtons();

// ---- a person on a plate (you, or someone else)
function makeAvatar(mine) {
  const el = document.createElement("div");
  el.className = "avatar" + (mine ? " mine" : "");
  const plate = document.createElement("div");
  plate.className = "plate";
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  const off = document.createElement("div");
  off.className = "off";
  off.textContent = "Camera off";
  plate.append(video, off);
  // the back: black, with the username in the middle (no webcam)
  const back = document.createElement("div");
  back.className = "plate-back";
  const backName = document.createElement("span");
  back.append(backName);
  el.append(plate, back);
  const tags = [];
  if (!mine) {
    for (const side of ["front", "back"]) {
      const tag = document.createElement("div");
      tag.className = `tag ${side}`;
      el.append(tag);
      tags.push(tag);
    }
  }
  world.append(el);
  return { el, video, tags, backName };
}

/** Where a plate stands and faces, and the face crop inside it. */
function placeAvatar(av, p) {
  // Worn like a body: it turns left/right with where its person looks, but
  // stays upright (never tips up or down when they look up or down).
  av.el.style.transform =
    `translate3d(${p.x}px, ${H / 2 - (p.eye ?? EYE)}px, ${p.z}px) rotateY(${180 - p.yaw}deg) ` +
    `scale(${PLATE_H / 360})`;
  av.video.style.transform = cropTransform(p.cx, p.cy, p.zoom);
}

// The crop is a 16:9 window on the 640 x 360 picture: the video is slid and
// scaled so that window fills the plate (CSS only, no canvas).
const SET_W = 640, SET_H = 360;
function cropTransform(cx, cy, zoom) {
  const cw = SET_W * zoom, ch = SET_H * zoom, k = 1 / zoom;
  return `translate(${-(cx - cw / 2) * k}px, ${-(cy - ch / 2) * k}px) scale(${k})`;
}

// ---- you
// You start in the aisle between the two rows of chairs, facing the front
// wall (somewhere left to right, so people do not land on each other).
// (beside the table's end, not in it: 2.4 to 2.7 m left or right of the middle)
const me = { x: (Math.random() < 0.5 ? -1 : 1) * Math.round(240 + Math.random() * 30), z: 0, yaw: 0, pitch: 0, eye: EYE, seat: -1 };
const mine = makeAvatar(true);
updateSitButton(); // its label needs you (me) to exist
// Your sight starts at your webcam plate (first person). V steps out behind
// it (third person) to see yourself.
let third = false;

// ---- FOV: horizontal degrees, the same at any window size
let fov = Number(recall("room_fov")) || 90;
let perspective = 0;
function setFov(next) {
  fov = clamp(Math.round(next), 60, 120);
  perspective = innerWidth / 2 / Math.tan((fov * Math.PI) / 360);
  view.style.perspective = perspective + "px";
  fovSlider.value = fov;
  fovText.value = fov;
  remember("room_fov", fov);
  draw();
}
fovSlider.addEventListener("input", () => setFov(Number(fovSlider.value)));
addEventListener("resize", () => setFov(fov));

// How far the camera can back away from you before it leaves the room.
function roomBehind(bx, bz) {
  let t = BEHIND;
  const limit = (pos, dir, half) => {
    if (dir > 0) t = Math.min(t, (half - 10 - pos) / dir);
    if (dir < 0) t = Math.min(t, (-half + 10 - pos) / dir);
  };
  limit(me.x, bx, W / 2);
  limit(me.z, bz, D / 2);
  return Math.max(0, t);
}

// Only draws when something changed.
let queued = false;
function draw() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    const a = (me.yaw * Math.PI) / 180;
    let cx = me.x, cy = H / 2 - me.eye, cz = me.z;
    if (third) {
      const bx = -Math.sin(a), bz = Math.cos(a); // straight behind you
      const t = roomBehind(bx, bz);
      cx += bx * t; cz += bz * t; cy -= ABOVE;
    }
    world.style.transform =
      `translateZ(${perspective}px) rotateX(${me.pitch}deg) rotateY(${me.yaw}deg) ` +
      `translate3d(${-cx}px, ${-cy}px, ${-cz}px)`;
    mine.el.classList.toggle("hidden", !third);
    placeAvatar(mine, { ...me, ...shown, yaw: bodyYaw() });
    sendPose();
  });
}

function look(dx, dy) {
  me.yaw = (me.yaw + dx * LOOK) % 360;
  me.pitch = clamp(me.pitch - dy * LOOK, -80, 80);
  draw();
}

// Mouse: click locks the pointer (Esc frees it). Touch and pen: drag.
view.addEventListener("click", () => view.requestPointerLock?.());
document.addEventListener("pointerlockchange", () => {
  view.classList.toggle("locked", document.pointerLockElement === view);
});
document.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement === view) look(e.movementX, e.movementY);
});
let drag = null;
view.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "mouse") drag = { x: e.clientX, y: e.clientY };
});
view.addEventListener("pointermove", (e) => {
  if (!drag) return;
  look(-(e.clientX - drag.x), -(e.clientY - drag.y));
  drag = { x: e.clientX, y: e.clientY };
});
addEventListener("pointerup", () => (drag = null));
addEventListener("pointercancel", () => (drag = null));

// Walking: a small loop runs only while a key is held.
const KEYS = {
  KeyW: [0, 1], ArrowUp: [0, 1], KeyS: [0, -1], ArrowDown: [0, -1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0],
};
const held = new Set();
let last = 0;
addEventListener("keydown", (e) => {
  if (!KEYS[e.code]) return;
  e.preventDefault();
  if (!held.size) { last = performance.now(); requestAnimationFrame(walk); }
  held.add(e.code);
});
addEventListener("keyup", (e) => held.delete(e.code));
addEventListener("blur", () => held.clear());

function walk(now) {
  if (!held.size) return;
  if (me.seat >= 0) standUp();
  const step = SPEED * Math.min(0.05, (now - last) / 1000);
  last = now;
  let side = 0, ahead = 0;
  for (const code of held) { side += KEYS[code][0]; ahead += KEYS[code][1]; }
  const len = Math.hypot(side, ahead) || 1;
  const a = (me.yaw * Math.PI) / 180;
  // ahead = (sin yaw, -cos yaw), right = (cos yaw, sin yaw) on the floor
  const nx = clamp(me.x + ((Math.sin(a) * ahead + Math.cos(a) * side) / len) * step, -W / 2 + MARGIN, W / 2 - MARGIN);
  const nz = clamp(me.z + ((-Math.cos(a) * ahead + Math.sin(a) * side) / len) * step, -D / 2 + MARGIN, D / 2 - MARGIN);
  // chairs block you; slide along them (each direction checked on its own).
  // Standing inside one (it was turned onto you), you can walk out.
  const stuck = inChair(me.x, me.z);
  if (stuck || !inChair(nx, me.z)) me.x = nx;
  if (stuck || !inChair(me.x, nz)) me.z = nz;
  draw();
  requestAnimationFrame(walk);
}

// ---- face tracking: your diamond follows your face and zooms to it
// Ported from the bunker's diamond (M2A-Access src/diamond/tracking.js and
// config.js), same numbers. The hexagon shows the whole picture.
const DIAMOND_RATIO = 1.45;                    // diamond halfW = halfH / 1.45
const DIAMOND_SHOWS = SET_H / 2 / DIAMOND_RATIO / (SET_W / 2); // of the crop's width
const TRACK = {
  smooth: 0.33,          // position blend per 60 fps frame
  zoomSmooth: 0.13,      // zoom moves more reluctantly than position
  headSmooth: 0.3,       // head size averaged per detection
  deadzone: 22,          // ignore wobble under 22 px (of 640)
  zoomDeadzone: 0.05,    // ignore size changes under 5%
  graceMs: 10000,        // face gone this long: back to the whole picture
  everyMs: 150,          // one detection every 150 ms
  detectWidth: 256,      // detection runs on a small copy of the frame
};
const FRAMING = { headX: 1.15, headY: 1.95, padding: 1.15, biasY: -0.12, minZoom: 0.28 };

const crop = { x: SET_W / 2, y: SET_H / 2, zoom: 1 };   // where it is
const want = { x: SET_W / 2, y: SET_H / 2, zoom: 1 };   // where it is going
const shown = { cx: SET_W / 2, cy: SET_H / 2, zoom: 1 }; // after the edge clamp: what others get
let headW = 0, headH = 0;
let seenAt = -Infinity;
const isHex = () => mine.el.classList.contains("hexagon");

// The webcam's own picture -> the plate's 640 x 360 (object-fit: cover).
function toSet(face) {
  const vw = mine.video.videoWidth, vh = mine.video.videoHeight;
  const s = Math.max(SET_W / vw, SET_H / vh);
  const ox = (vw * s - SET_W) / 2, oy = (vh * s - SET_H) / 2;
  return { cx: face.centerX * s - ox, cy: face.centerY * s - oy, w: face.width * s, h: face.height * s };
}

function onFace(face) {
  if (!face) return;
  const f = toSet(face);
  // the face box grown out to the whole head, nudged up to keep the hair
  const w = f.w * FRAMING.headX, h = f.h * FRAMING.headY;
  const cx = f.cx, cy = f.cy + h * FRAMING.biasY;
  const now = performance.now();
  const reacquired = now - seenAt > TRACK.graceMs || !headW;
  if (reacquired) { headW = w; headH = h; }
  else { headW += (w - headW) * TRACK.headSmooth; headH += (h - headH) * TRACK.headSmooth; }
  // smallest crop that fits the head (an oval) inside the diamond, plus room
  const zoom = clamp((Math.hypot(headW * DIAMOND_RATIO, headH) / SET_H) * FRAMING.padding, FRAMING.minZoom, 1);
  if (reacquired) {
    want.x = crop.x = cx; want.y = crop.y = cy; want.zoom = crop.zoom = zoom;
  } else {
    if (Math.abs(cx - want.x) >= TRACK.deadzone) want.x = cx;
    if (Math.abs(cy - want.y) >= TRACK.deadzone) want.y = cy;
    if (Math.abs(zoom - want.zoom) >= Math.max(want.zoom, FRAMING.minZoom) * TRACK.zoomDeadzone) want.zoom = zoom;
  }
  seenAt = now;
  glideCrop();
}

// Eases the crop toward where it is going, then stops: no loop while still.
let gliding = false, glideAt = 0;
function glideCrop() {
  if (gliding) return;
  gliding = true;
  glideAt = performance.now();
  requestAnimationFrame(glideStep);
}
function glideStep(now) {
  const steps = Math.max(0, now - glideAt) / (1000 / 60);
  glideAt = now;
  const hex = isHex();
  const lost = now - seenAt > TRACK.graceMs;
  const to = hex || lost ? { x: SET_W / 2, y: SET_H / 2, zoom: 1 } : want;
  const blend = (cur, target, a) => cur + (target - cur) * (1 - Math.pow(1 - a, steps));
  crop.x = blend(crop.x, to.x, TRACK.smooth);
  crop.y = blend(crop.y, to.y, TRACK.smooth);
  crop.zoom = blend(crop.zoom, to.zoom, hex ? TRACK.smooth : TRACK.zoomSmooth);

  // Keep the part the shape shows inside the picture: the diamond hides
  // the crop's sides, so those may hang past the picture's edge.
  const cw = SET_W * crop.zoom, ch = SET_H * crop.zoom;
  const halfW = (cw / 2) * (hex ? 1 : DIAMOND_SHOWS) + 2;
  shown.cx = halfW * 2 >= SET_W ? SET_W / 2 : clamp(crop.x, halfW, SET_W - halfW);
  shown.cy = clamp(crop.y, ch / 2, SET_H - ch / 2);
  shown.zoom = crop.zoom;
  draw();

  const moving =
    Math.abs(crop.x - to.x) > 0.3 || Math.abs(crop.y - to.y) > 0.3 || Math.abs(crop.zoom - to.zoom) > 0.001;
  if (moving) requestAnimationFrame(glideStep);
  else gliding = false;
}

// Detection: a small still of the webcam every 150 ms, to the worker.
let worker = null, busy = false, timer = 0, loseTimer = 0;
function startTracking() {
  if (!worker) {
    try {
      worker = new Worker(`${import.meta.env.BASE_URL}room/face-worker.js`);
      worker.onmessage = (e) => {
        busy = false;
        if (e.data.error) console.warn("[room] face tracking:", e.data.error);
        else if (stream) onFace(e.data.face);
      };
      worker.onerror = (e) => { busy = false; console.warn("[room] face tracking worker:", e.message); };
    } catch (err) {
      console.warn("[room] no face tracking:", err);
      return;
    }
  }
  clearInterval(timer);
  timer = setInterval(detect, TRACK.everyMs);
  // once the face has been gone the grace period, ease back out
  clearInterval(loseTimer);
  loseTimer = setInterval(() => { if (performance.now() - seenAt > TRACK.graceMs) glideCrop(); }, 1000);
}
function stopTracking() {
  clearInterval(timer);
  clearInterval(loseTimer);
  seenAt = -Infinity;
  headW = headH = 0;
  Object.assign(want, { x: SET_W / 2, y: SET_H / 2, zoom: 1 });
  Object.assign(crop, want);
  Object.assign(shown, { cx: SET_W / 2, cy: SET_H / 2, zoom: 1 });
  draw();
}
async function detect() {
  const v = mine.video, vw = v.videoWidth, vh = v.videoHeight;
  if (busy || !stream || !vw || v.readyState < 2 || document.hidden) return;
  busy = true;
  try {
    const dw = Math.min(vw, TRACK.detectWidth);
    const bitmap = await createImageBitmap(v, {
      resizeWidth: dw, resizeHeight: Math.round((vh * dw) / vw), resizeQuality: "low",
    });
    worker.postMessage({ bitmap, scale: vw / bitmap.width }, [bitmap]);
  } catch {
    busy = false;
  }
}

// ---- your webcam, shape and view
let stream = null;
let camTrack = null; // the webcam as published to the room
async function setCamera(on) {
  if (on && !stream) {
    try {
      // 16:9, a size a home upload can carry to everyone
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 960 }, height: { ideal: 540 }, aspectRatio: 16 / 9, frameRate: { ideal: 24 } },
        audio: false,
      });
    } catch {
      camBtn.textContent = "Camera blocked (C)";
      return;
    }
    mine.video.srcObject = stream;
    startTracking();
    void publishCamera();
  } else if (!on && stream) {
    stopTracking();
    void unpublishCamera();
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
    mine.video.srcObject = null;
  }
  mine.el.classList.toggle("live", Boolean(stream));
  camBtn.setAttribute("aria-pressed", String(Boolean(stream)));
  camBtn.textContent = stream ? "Camera on (C)" : "Camera off (C)";
  remember("room_cam", stream ? "1" : "0");
  sendPose(true);
}
function setShape(hex) {
  mine.el.classList.toggle("hexagon", hex);
  shapeBtn.textContent = hex ? "Diamond (G)" : "Hexagon (G)";
  remember("room_shape", hex ? "hexagon" : "diamond");
  glideCrop();
  sendPose(true);
}
function setThird(on) {
  third = on;
  povBtn.textContent = on ? "First person (V)" : "Third person (V)";
  remember("room_view", on ? "third" : "first");
  draw();
}
camBtn.addEventListener("click", () => setCamera(!stream));
shapeBtn.addEventListener("click", () => setShape(!isHex()));
povBtn.addEventListener("click", () => setThird(!third));
addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (e.code === "KeyC") setCamera(!stream);
  if (e.code === "KeyG") setShape(!isHex());
  if (e.code === "KeyV") setThird(!third);
  const n = /^Digit([1-4])$/.exec(e.code);
  if (n) toggleShare(SCREENS[Number(n[1]) - 1]);
  if (e.code === "BracketLeft") setFov(fov - 5);
  if (e.code === "BracketRight") setFov(fov + 5);
});
// Darkwood Node's "Camera off" turns it off here too.
addEventListener("message", (e) => {
  if (e.source === parent && e.origin === location.origin && e.data?.type === "dh-camera-off") setCamera(false);
});

// ---- the room on LiveKit
const params = new URLSearchParams(location.search);
const serverId = params.get("s") ?? "";
const channelId = params.get("c") ?? "";
let room = null;

/** A LiveKit pass: for this room, or (call) to watch the tile's videochat. */
async function getPass(user, call = false) {
  const idToken = await user.getIdToken();
  const res = await fetch("/api/dh-token", {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    // wall: the hidden, watch-only pass the 3D rooms use to show the call
    body: JSON.stringify(call ? { serverId, channelId, wall: true } : { serverId, channelId, room: true }),
  });
  const pass = await res.json().catch(() => ({}));
  if (!res.ok || !pass.url || !pass.token) throw new Error(pass.error || "Could not join the room.");
  return pass;
}

async function join(pass) {
  setStatus("Joining the room…");

  // Every plate is drawn by the browser itself, never "seen" the way a
  // normal video tile is, so LiveKit must not pause videos it thinks hidden.
  room = new Room({ adaptiveStream: false, dynacast: true });
  room
    .on(RoomEvent.ParticipantConnected, (p) => {
      addPerson(p);
      sendPose(true);
      for (const s of SCREENS) if (s.tvAt) sendTv(s, [p.identity]); // what is on TV
      for (const c of CHAIRS) if (c.turnAt) sendChair(c, [p.identity]); // how chairs are turned
    })
    .on(RoomEvent.ParticipantDisconnected, (p) => { removePerson(p.identity); clearScreensOf(p.identity); })
    .on(RoomEvent.TrackSubscribed, (track, pub, p) => {
      const screen = screenOfTrack(pub.trackName);
      if (screen) showOnScreen(screen, track, p);
      else if (pub.source === Track.Source.Camera) track.attach(addPerson(p).video);
    })
    .on(RoomEvent.TrackUnsubscribed, (track, pub, p) => {
      track.detach();
      const screen = screenOfTrack(pub.trackName);
      if (screen && screen.owner === p.identity) clearScreen(screen);
    })
    .on(RoomEvent.DataReceived, (data, p, _kind, topic) => {
      if (topic === "pose" && p) onPose(p, data);
      if (topic === "tv") onTv(data);
      if (topic === "chair") onChair(data);
    })
    .on(RoomEvent.Disconnected, () => setStatus("Left the room. Reload to come back in.", true));
  await room.connect(pass.url, pass.token);
  for (const p of room.remoteParticipants.values()) addPerson(p);
  setStatus("");
  updateCount();
  if (stream) await publishCamera();
  sendPose(true);
  setInterval(() => sendPose(true), 2000); // newcomers learn where you are
}

async function publishCamera() {
  if (!room || !stream || camTrack) return;
  const track = new LocalVideoTrack(stream.getVideoTracks()[0], undefined, true);
  camTrack = track;
  try {
    await room.localParticipant.publishTrack(track, {
      source: Track.Source.Camera,
      simulcast: false,
      videoEncoding: { maxBitrate: 600_000, maxFramerate: 24 },
      degradationPreference: "maintain-framerate",
    });
  } catch (err) {
    camTrack = null;
    console.warn("[room] could not send the webcam:", err);
  }
}
async function unpublishCamera() {
  const track = camTrack;
  camTrack = null;
  if (room && track) await room.localParticipant.unpublishTrack(track, false).catch(() => {});
}

// Your pose, at most 10 times a second and only when it changed (plus a
// heartbeat), as a small unreliable message: a lost one is replaced soon.
let lastSent = 0, sendTimer = 0, lastPose = "";
function sendPose(force = false) {
  if (!room || room.state !== "connected") return;
  const pose = JSON.stringify({
    x: Math.round(me.x), z: Math.round(me.z),
    yaw: Math.round(bodyYaw() * 10) / 10, pitch: Math.round(me.pitch * 10) / 10,
    eye: me.eye, seat: me.seat,
    hex: isHex(), cam: Boolean(stream),
    cx: Math.round(shown.cx), cy: Math.round(shown.cy), zoom: Math.round(shown.zoom * 1000) / 1000,
  });
  if (!force && pose === lastPose) return;
  const wait = 100 - (performance.now() - lastSent);
  if (wait > 0) {
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => sendPose(force), wait);
    return;
  }
  lastSent = performance.now();
  lastPose = pose;
  room.localParticipant
    .publishData(new TextEncoder().encode(pose), { reliable: false, topic: "pose" })
    .catch(() => {});
}

// ---- everyone else
const people = new Map(); // identity -> { el, video, tags, at, to }

function addPerson(p) {
  let person = people.get(p.identity);
  if (person) return person;
  person = makeAvatar(false);
  const start = { x: 0, z: 0, yaw: 0, pitch: 0, eye: EYE, cx: SET_W / 2, cy: SET_H / 2, zoom: 1 };
  person.at = { ...start };
  person.to = { ...start };
  person.el.classList.add("hidden"); // until their first pose says where they are
  people.set(p.identity, person);
  setName(person, p.name || "Someone");
  // the name they use in Darkwood Node (the one on their webcam, if set)
  getDoc(doc(db, "profiles", p.identity))
    .then((snap) => {
      const prof = snap.data();
      if (prof) setName(person, prof.username || prof.callName || prof.name || p.name);
    })
    .catch(() => {});
  updateCount();
  return person;
}
function setName(person, name) {
  person.name = name;
  for (const tag of person.tags) tag.textContent = name;
  person.backName.textContent = name;
}
function removePerson(identity) {
  const person = people.get(identity);
  if (!person) return;
  person.el.remove();
  people.delete(identity);
  updateCount();
}
function updateCount() {
  if (statusBox.classList.contains("problem") || !room) return;
  const n = people.size;
  setStatus(n ? `${n + 1} people in the room` : "Only you here for now");
}

function onPose(p, data) {
  let pose;
  try { pose = JSON.parse(new TextDecoder().decode(data)); } catch { return; }
  const person = addPerson(p);
  const first = person.el.classList.contains("hidden");
  person.el.classList.remove("hidden");
  person.el.classList.toggle("hexagon", Boolean(pose.hex));
  person.el.classList.toggle("live", Boolean(pose.cam));
  Object.assign(person.to, {
    x: +pose.x || 0, z: +pose.z || 0, yaw: +pose.yaw || 0, pitch: +pose.pitch || 0,
    eye: clamp(+pose.eye || EYE, 60, 200),
    cx: +pose.cx || SET_W / 2, cy: +pose.cy || SET_H / 2, zoom: +pose.zoom || 1,
  });
  person.seat = Number.isInteger(pose.seat) ? pose.seat : -1;
  if (first) Object.assign(person.at, person.to);
  glidePeople();
}

// Others glide to where their last pose put them, then everything stops.
let peopleGliding = false;
function glidePeople() {
  if (peopleGliding) return;
  peopleGliding = true;
  requestAnimationFrame(peopleStep);
}
function peopleStep() {
  let moving = false;
  for (const person of people.values()) {
    const { at, to } = person;
    // yaw goes the short way round
    const turn = ((((to.yaw - at.yaw) % 360) + 540) % 360) - 180;
    at.yaw += turn * 0.3;
    for (const k of ["x", "z", "pitch", "eye", "cx", "cy"]) at[k] += (to[k] - at[k]) * 0.3;
    at.zoom += (to.zoom - at.zoom) * 0.3;
    if (Math.abs(turn) > 0.1 || ["x", "z", "pitch", "eye", "cx", "cy"].some((k) => Math.abs(to[k] - at[k]) > 0.2) ||
        Math.abs(to.zoom - at.zoom) > 0.001) moving = true;
    placeAvatar(person, at);
  }
  if (moving) requestAnimationFrame(peopleStep);
  else peopleGliding = false;
}

// ---- the tile's videochat, as small screens under the room
// Watched with a hidden, watch-only pass (nobody sees it in the call). Shows
// everyone in the call: their webcam, or their username on black while it is off.
const strip = document.getElementById("strip");
const side = document.getElementById("side");
const ROW = 4; // small screens under the room; the rest go in the column
const callers = new Map(); // identity -> { el, video, who, center }

async function watchCall(pass) {
  const call = new Room({ adaptiveStream: false, dynacast: false });
  const refresh = (p) => {
    const tile = callers.get(p.identity);
    if (!tile) return;
    const cam = p.getTrackPublication(Track.Source.Camera);
    tile.el.classList.toggle("live", Boolean(cam?.track && cam.isSubscribed && !cam.isMuted));
  };
  call
    .on(RoomEvent.ParticipantConnected, (p) => addCaller(p))
    .on(RoomEvent.ParticipantDisconnected, (p) => removeCaller(p.identity))
    .on(RoomEvent.TrackSubscribed, (track, pub, p) => {
      if (pub.source === Track.Source.Camera) track.attach(addCaller(p).video);
      refresh(p);
    })
    // LiveKit drops the publication just after these events: look again after
    .on(RoomEvent.TrackUnsubscribed, (track, _pub, p) => { track.detach(); setTimeout(() => refresh(p)); })
    .on(RoomEvent.TrackUnpublished, (_pub, p) => setTimeout(() => refresh(p)))
    .on(RoomEvent.TrackMuted, (_pub, p) => refresh(p))
    .on(RoomEvent.TrackUnmuted, (_pub, p) => refresh(p))
    .on(RoomEvent.ParticipantNameChanged, (_name, p) => addCaller(p));
  await call.connect(pass.url, pass.token);
  for (const p of call.remoteParticipants.values()) { addCaller(p); refresh(p); }
}

function addCaller(p) {
  let tile = callers.get(p.identity);
  if (tile) return tile;
  const el = document.createElement("div");
  el.className = "call-tile";
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  const center = document.createElement("div");
  center.className = "name";
  const who = document.createElement("div");
  who.className = "who";
  el.append(video, center, who);
  tile = { el, video, who, center };
  callers.set(p.identity, tile);
  const name = (n) => { who.textContent = n; center.textContent = n; };
  name(p.name || "Someone");
  // a person's identity is their uid; the call's other names are "uid:..."
  getDoc(doc(db, "profiles", p.identity.split(":")[0]))
    .then((snap) => { const prof = snap.data(); if (prof) name(prof.username || prof.callName || prof.name || p.name); })
    .catch(() => {});
  layoutCall();
  return tile;
}
function removeCaller(identity) {
  const tile = callers.get(identity);
  if (!tile) return;
  tile.video.srcObject = null;
  tile.el.remove();
  callers.delete(identity);
  layoutCall();
}
function layoutCall() {
  const tiles = [...callers.values()];
  tiles.forEach((t, i) => (i < ROW ? strip : side).append(t.el));
  document.body.classList.toggle("calling", tiles.length > 0);
}

// ---- start
setFov(fov);
setShape(recall("room_shape") === "hexagon");
setThird(recall("room_view") === "third");
// You are here to be seen: the webcam starts on unless you turned it off.
void setCamera(recall("room_cam") !== "0");

// Testing on this PC only (never in the live build): ?lk=<url>&token=<pass>
// joins with a pass signed by hand, so tests never use anyone's login.
const testPass = import.meta.env.DEV && params.get("token") ? { url: params.get("lk"), token: params.get("token") } : null;

if (testPass) {
  join(testPass).catch((err) => setStatus(err?.message || "Could not join the room.", true));
  // ?calltoken=<pass> watches a test call the same way
  if (params.get("calltoken")) watchCall({ url: params.get("lk"), token: params.get("calltoken") }).catch((err) => console.warn("[room] call:", err));
} else if (!serverId || !channelId) {
  setStatus("Open this room from its tile in Darkwood Node.", true, { href: import.meta.env.BASE_URL, text: "Go to Darkwood Node" });
} else {
  let started = false;
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      if (!started) setStatus("Log in to Darkwood Node first.", true, { href: `${import.meta.env.BASE_URL}?login`, text: "Log in" });
      return;
    }
    if (started) return;
    started = true;
    // your own username on the back of your plate
    getDoc(doc(db, "profiles", user.uid))
      .then((snap) => { const prof = snap.data(); if (prof) setName(mine, prof.username || prof.name || ""); })
      .catch(() => {});
    getPass(user).then(join).catch((err) => setStatus(err?.message || "Could not join the room.", true));
    getPass(user, true).then(watchCall).catch((err) => console.warn("[room] could not show the videochat:", err));
  });
}
