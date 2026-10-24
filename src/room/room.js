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

// ---- room size, matching room.html (px, 100 px = 1 m)
const W = 600, D = 600, H = 300;
const EYE = 160;    // eye height above the floor
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
    `translate3d(${p.x}px, ${EYE_Y}px, ${p.z}px) rotateY(${180 - p.yaw}deg) ` +
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
// You start somewhere near the back wall, facing the front wall.
const me = { x: Math.round((Math.random() - 0.5) * 300), z: D / 4, yaw: 0, pitch: 0 };
const mine = makeAvatar(true);
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
    let cx = me.x, cy = EYE_Y, cz = me.z;
    if (third) {
      const bx = -Math.sin(a), bz = Math.cos(a); // straight behind you
      const t = roomBehind(bx, bz);
      cx += bx * t; cz += bz * t; cy -= ABOVE;
    }
    world.style.transform =
      `translateZ(${perspective}px) rotateX(${me.pitch}deg) rotateY(${me.yaw}deg) ` +
      `translate3d(${-cx}px, ${-cy}px, ${-cz}px)`;
    mine.el.classList.toggle("hidden", !third);
    placeAvatar(mine, { ...me, ...shown });
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
  const step = SPEED * Math.min(0.05, (now - last) / 1000);
  last = now;
  let side = 0, ahead = 0;
  for (const code of held) { side += KEYS[code][0]; ahead += KEYS[code][1]; }
  const len = Math.hypot(side, ahead) || 1;
  const a = (me.yaw * Math.PI) / 180;
  // ahead = (sin yaw, -cos yaw), right = (cos yaw, sin yaw) on the floor
  me.x += ((Math.sin(a) * ahead + Math.cos(a) * side) / len) * step;
  me.z += ((-Math.cos(a) * ahead + Math.sin(a) * side) / len) * step;
  me.x = clamp(me.x, -W / 2 + MARGIN, W / 2 - MARGIN);
  me.z = clamp(me.z, -D / 2 + MARGIN, D / 2 - MARGIN);
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
    .on(RoomEvent.ParticipantConnected, (p) => { addPerson(p); sendPose(true); })
    .on(RoomEvent.ParticipantDisconnected, (p) => removePerson(p.identity))
    .on(RoomEvent.TrackSubscribed, (track, _pub, p) => {
      if (track.kind === Track.Kind.Video) track.attach(addPerson(p).video);
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => track.detach())
    .on(RoomEvent.DataReceived, (data, p, _kind, topic) => {
      if (topic === "pose" && p) onPose(p, data);
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
    yaw: Math.round(me.yaw * 10) / 10, pitch: Math.round(me.pitch * 10) / 10,
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
  const start = { x: 0, z: 0, yaw: 0, pitch: 0, cx: SET_W / 2, cy: SET_H / 2, zoom: 1 };
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
  showWho();
}

// The terminal on the front wall: `who` lists everyone in the room.
const whoList = document.getElementById("who");
function showWho() {
  const names = [mine.name || "you", ...[...people.values()].map((p) => p.name || "someone")];
  whoList.textContent = names.map((n) => `  ${n}`).join("\n");
}
function removePerson(identity) {
  const person = people.get(identity);
  if (!person) return;
  person.el.remove();
  people.delete(identity);
  updateCount();
}
function updateCount() {
  showWho();
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
    cx: +pose.cx || SET_W / 2, cy: +pose.cy || SET_H / 2, zoom: +pose.zoom || 1,
  });
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
    for (const k of ["x", "z", "pitch", "cx", "cy"]) at[k] += (to[k] - at[k]) * 0.3;
    at.zoom += (to.zoom - at.zoom) * 0.3;
    if (Math.abs(turn) > 0.1 || ["x", "z", "pitch", "cx", "cy"].some((k) => Math.abs(to[k] - at[k]) > 0.2) ||
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
