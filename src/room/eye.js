// Each person's eye is the Eye.glb mesh. One WebGL view covers the room and
// is redrawn only when the camera or a gaze changes. Nothing here is a CSS shape.
//
// The view camera uses the same yaw and pitch as the CSS room. lookDir() is
// that direction (yaw 0 looks down −z, positive yaw is the person's right,
// positive pitch looks up). lookAt points the eye group's +Z along lookDir.
// After load, the iris is measured by counting green pixels from each side,
// and the mesh is turned so that side becomes +Z.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export const EYE_RADIUS = 22;
export const EYE_GAP = 8;

const RAD = Math.PI / 180;
const URL = `${import.meta.env.BASE_URL}room/Eye.glb`;

let renderer = null;
let scene = null;
let camera = null;
let template = null;
let failed = false;
let loading = false;
let queued = null;
const eyes = [];
let lastKey = "";
const _look = new THREE.Vector3();
const _target = new THREE.Vector3();

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
  renderer.setSize(64, 64, false);
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

// The photo is 4096 in the source file. On screen the eye is small, so the
// picture is drawn at 512. One shared texture, no mipmaps.
function shrinkMap(tex) {
  const img = tex.image;
  if (!img || img.width <= 512) {
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  canvas.getContext("2d").drawImage(img, 0, 0, 512, 512);
  tex.image = canvas;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
}

function greenCount(buf) {
  let n = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i + 1] > buf[i] + 15 && buf[i + 1] > buf[i + 2] + 8 && buf[i + 1] > 30) n++;
  }
  return n;
}

// Which way the iris faces. The glass bulge on the source file is +Z, but the
// painted iris is wherever the texture put it, so this is measured.
function irisDirection(object) {
  const measure = new THREE.Scene();
  measure.add(object);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 800);
  const rt = new THREE.WebGLRenderTarget(96, 96);
  const buf = new Uint8Array(96 * 96 * 4);
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  let best = [0, 0, 1];
  let bestN = -1;
  const scores = {};
  for (const d of dirs) {
    cam.position.set(d[0] * EYE_RADIUS * 4.2, d[1] * EYE_RADIUS * 4.2, d[2] * EYE_RADIUS * 4.2);
    cam.up.set(Math.abs(d[1]) > 0.9 ? 0 : 0, Math.abs(d[1]) > 0.9 ? 0 : 1, Math.abs(d[1]) > 0.9 ? 1 : 0);
    cam.lookAt(0, 0, 0);
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(measure, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, 96, 96, buf);
    const n = greenCount(buf);
    scores[d.join(",")] = n;
    if (n > bestN) { bestN = n; best = d; }
  }
  renderer.setRenderTarget(null);
  measure.remove(object);
  rt.dispose();
  if (import.meta.env.DEV) window.__eyeScores = scores;
  if (bestN < 5) return new THREE.Vector3(0, 0, 1);
  return new THREE.Vector3(best[0], best[1], best[2]);
}

function mountEye(root) {
  const drop = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const map = o.material?.map;
    if (!map) { drop.push(o); return; }
    shrinkMap(map);
    const previous = o.material;
    // The file winds the iris inward. FrontSide draws that disk on the far
    // side of the ball, so it orbits against the gaze. BackSide draws the
    // same iris on the near side, the side lookAt aims along +Z.
    o.material = new THREE.MeshBasicMaterial({ map, side: THREE.BackSide });
    previous.map = null;
    previous.dispose();
    o.castShadow = false;
    o.receiveShadow = false;
  });
  for (const o of drop) o.removeFromParent();

  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  root.position.sub(center);
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) / 2 || 1;
  const fit = new THREE.Group();
  fit.add(root);
  fit.scale.setScalar(EYE_RADIUS / radius);

  const mount = new THREE.Group();
  mount.quaternion.setFromUnitVectors(irisDirection(fit), new THREE.Vector3(0, 0, 1));
  mount.add(fit);
  return mount;
}

function startLoad() {
  if (template || loading || failed) return;
  loading = true;
  new GLTFLoader().load(URL, (gltf) => {
    template = mountEye(gltf.scene);
    loading = false;
    if (import.meta.env.DEV) window.__eyeReady = true;
    if (queued) {
      const next = queued;
      queued = null;
      lastKey = "";
      renderEyes(next.entries, next.cam, next.parent);
    }
  }, undefined, (err) => {
    failed = true;
    loading = false;
    console.warn("[eye] load failed", err);
  });
}

function makeEye() {
  const group = new THREE.Group();
  group.add(template.clone(true));
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
  if (key === lastKey && template) return;
  boot(parent);
  if (!renderer) return;
  if (!template) {
    queued = { entries, cam, parent };
    startLoad();
    return;
  }
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
  let gw = 0, gx = 0, gy = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (buf[i + 3] < 30) continue;
      if (!(buf[i + 1] > buf[i] + 15 && buf[i + 1] > buf[i + 2] + 8 && buf[i + 1] > 30)) continue;
      const sy = h - 1 - y;
      gw++; gx += x; gy += sy;
    }
  }
  return gw ? { iris: { x: Math.round(gx / gw), y: Math.round(gy / gw), n: gw } } : { iris: null };
}
