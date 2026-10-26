// Each person's eye is a three.js sphere and pupil. One WebGL view covers the
// room and is redrawn only when the camera or a gaze changes. Nothing here is
// a CSS shape: the mesh is the eye.
//
// The view camera uses the same yaw and pitch as the CSS room. lookDir() is
// that direction (yaw 0 looks down −z, positive yaw is the person's right,
// positive pitch looks up). A check against the CSS projection matched within
// a pixel. The pupil sits on the mesh's local +Z, and lookAt points +Z along
// lookDir, so the pupil is where that person is looking.

import * as THREE from "three";

export const EYE_RADIUS = 22;
export const EYE_GAP = 8;

const RAD = Math.PI / 180;

let renderer = null;
let scene = null;
let camera = null;
let failed = false;
const eyes = [];
let lastKey = "";
const _look = new THREE.Vector3();
const _target = new THREE.Vector3();

const scleraGeo = new THREE.SphereGeometry(EYE_RADIUS, 10, 8);
const pupilGeo = new THREE.SphereGeometry(EYE_RADIUS * 0.45, 8, 6);
const scleraMat = new THREE.MeshBasicMaterial({ color: 0xb4b4b4 });
const pupilMat = new THREE.MeshBasicMaterial({ color: 0x111111 });

function lookDir(yawDeg, pitchDeg, out) {
  const yaw = yawDeg * RAD;
  const pitch = pitchDeg * RAD;
  const cp = Math.cos(pitch);
  return out.set(Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

function boot(parent) {
  if (renderer || failed) return;
  try {
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: false,
      depth: true,
      stencil: false,
      powerPreference: "low-power",
    });
  } catch (err) {
    failed = true;
    console.warn("[eye] no WebGL", err);
    return;
  }
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.pointerEvents = "none";
  parent.append(canvas);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, 1, 1, 4000);
}

function makeEye() {
  const group = new THREE.Group();
  const pupil = new THREE.Mesh(pupilGeo, pupilMat);
  pupil.position.z = EYE_RADIUS * 0.78;
  group.add(new THREE.Mesh(scleraGeo, scleraMat), pupil);
  scene.add(group);
  return group;
}

/**
 * entries: { x, y, z, gaze, pitch } in room pixels. y is CSS, positive down.
 * cam: { x, y, z, yaw, pitch, perspective, width, height } in that same room.
 * @param {HTMLElement} parent the room view, where the one WebGL canvas sits
 */
export function renderEyes(entries, cam, parent) {
  if (failed) return;
  if (!entries.length) {
    if (renderer && lastKey !== "0") {
      for (const eye of eyes) eye.visible = false;
      renderer.clear();
      lastKey = "0";
    }
    return;
  }
  const key = [
    cam.width, cam.height, Math.round(cam.perspective),
    Math.round(cam.x), Math.round(cam.y), Math.round(cam.z),
    cam.yaw.toFixed(1), cam.pitch.toFixed(1),
    ...entries.flatMap((e) => [Math.round(e.x), Math.round(e.y), Math.round(e.z), (+e.gaze).toFixed(1), (+e.pitch).toFixed(1)]),
  ].join(",");
  if (key === lastKey) return;
  boot(parent);
  if (!renderer) return;
  renderer.setPixelRatio(1);
  renderer.setSize(cam.width, cam.height, false);
  const fov = 2 * Math.atan(cam.height / (2 * cam.perspective)) * (180 / Math.PI);
  if (camera.fov !== fov || camera.aspect !== cam.width / cam.height) {
    camera.fov = fov;
    camera.aspect = cam.width / cam.height;
    camera.updateProjectionMatrix();
  }
  camera.position.set(cam.x, -cam.y, cam.z);
  camera.up.set(0, 1, 0);
  lookDir(cam.yaw, cam.pitch, _look);
  camera.lookAt(_target.copy(camera.position).add(_look));
  while (eyes.length < entries.length) eyes.push(makeEye());
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const eye = eyes[i];
    eye.visible = true;
    eye.position.set(entry.x, -entry.y, entry.z);
    lookDir(entry.gaze, entry.pitch, _look);
    eye.lookAt(_target.copy(eye.position).add(_look));
  }
  for (let i = entries.length; i < eyes.length; i++) eyes[i].visible = false;
  renderer.render(scene, camera);
  lastKey = key;
}

export function sampleEye() {
  if (!renderer) return null;
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let dw = 0, dx = 0, dy = 0, ow = 0, ox = 0, oy = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (buf[i + 3] < 30) continue;
      const lum = (buf[i] + buf[i + 1] + buf[i + 2]) / 3;
      const sy = h - 1 - y;
      ow++; ox += x; oy += sy;
      if (lum < 50) { dw++; dx += x; dy += sy; }
    }
  }
  const at = (n, sx, sy) => (n ? { x: Math.round(sx / n), y: Math.round(sy / n), n } : null);
  return { pupil: at(dw, dx, dy), ball: at(ow, ox, oy) };
}
