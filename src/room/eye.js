// Each person's eye is the Eye.glb mesh. One WebGL view covers the room and
// is redrawn only when the camera, a gaze, or an iris hue changes. Nothing here is a CSS shape.
//
// The view camera uses the same yaw and pitch as the CSS room. lookDir() is
// that direction (yaw 0 looks down −z, positive yaw is the person's right,
// positive pitch looks up). lookAt points the eye group's +Z along lookDir.
// After load, the iris is measured by counting green pixels from each side,
// and the mesh is turned so that side becomes +Z.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// 22 was the full ball. 70% smaller leaves 30% of that.
export const EYE_RADIUS = 22 * 0.3;
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
const blockers = [];
let hexGeo = null;
let blockMat = null;
let lastKey = "";
const _look = new THREE.Vector3();
const _target = new THREE.Vector3();
let baseMap = null;
let irisSrc = null;
const hueTextures = new Map();

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
    captureBase(tex);
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
  captureBase(tex);
}

// The painted iris is the green part of the picture. A hue keeps its shading
// and leaves the white, the veins, and the pupil alone. One picture per hue,
// shared by everyone who picked that hue. 0 is the color in the file.
function captureBase(tex) {
  const img = tex.image;
  if (!img || baseMap) return;
  baseMap = tex;
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const image = ctx.getImageData(0, 0, img.width, img.height);
  irisSrc = { w: img.width, h: img.height, data: new Uint8ClampedArray(image.data) };
}

function hueWrap(hue) {
  return ((Math.round(+hue) % 360) + 360) % 360;
}

function hsvToRgb(h, s, v) {
  const c = v * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function irisMap(hue) {
  hue = hueWrap(hue);
  if (!hue || !irisSrc) return baseMap;
  const cached = hueTextures.get(hue);
  if (cached) return cached;
  const { w, h, data } = irisSrc;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const image = ctx.createImageData(w, h);
  const out = image.data;
  out.set(data);
  for (let i = 0; i < out.length; i += 4) {
    const r = out[i], g = out[i + 1], b = out[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    if (d < 20 || max < 30 || d / max < 0.28) continue;
    let hh;
    if (max === r) hh = ((g - b) / d) % 6;
    else if (max === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh = (hh * 60 + 360) % 360;
    if (hh < 50 || hh > 170) continue;
    const rgb = hsvToRgb((hh + hue) % 360, d / max, max / 255);
    out[i] = rgb[0];
    out[i + 1] = rgb[1];
    out[i + 2] = rgb[2];
  }
  ctx.putImageData(image, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  hueTextures.set(hue, tex);
  return tex;
}

function paintHue(eye, hue) {
  const map = irisMap(hue);
  if (!map) return;
  eye.traverse((o) => {
    if (!o.isMesh || !o.material || o.material.map === map) return;
    o.material.map = map;
  });
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
      renderEyes(next.entries, next.plates, next.cam, next.parent);
    }
  }, undefined, (err) => {
    failed = true;
    loading = false;
    console.warn("[eye] load failed", err);
  });
}

function makeEye() {
  const group = template.clone(true);
  group.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    o.material = o.material.clone();
    o.renderOrder = 1;
  });
  scene.add(group);
  return group;
}

// The hexagon the CSS webcam is clipped to, in the plate's own pixels
// (origin at the plate center, y down). One shared shape.
function hexagonGeometry() {
  if (hexGeo) return hexGeo;
  const shape = new THREE.Shape();
  const pts = [[0.14, 0], [0.86, 0], [1, 0.5], [0.86, 1], [0.14, 1], [0, 0.5]];
  pts.forEach(([u, v], i) => {
    const x = (u - 0.5) * 640;
    const y = (0.5 - v) * 360;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  });
  hexGeo = new THREE.ShapeGeometry(shape);
  return hexGeo;
}

function makeBlocker() {
  if (!blockMat) {
    blockMat = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: true,
      side: THREE.DoubleSide,
    });
  }
  const mesh = new THREE.Mesh(hexagonGeometry(), blockMat);
  mesh.renderOrder = 0;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}

/**
 * entries: { x, y, z, gaze, pitch, hue } in room pixels. y is CSS, positive down.
 * hue is degrees added to the iris. 0 keeps the green from the file.
 * plates: the webcam hexagons, { x, y, z, yaw, scale }. They are drawn into the
 * depth buffer only, before the eyes, so a nearer webcam covers an eye behind it.
 * The CSS plate then shows through. y is the plate center, CSS positive down.
 * yaw is the plate's body yaw: CSS rotateY(180 − yaw), which is the same angle
 * on three's Y once the plate's local Y is flipped to point up.
 * cam: { x, y, z, yaw, pitch, perspective, width, height } in that same room.
 * @param {HTMLElement} parent the room view, where the one WebGL canvas sits
 */
export function renderEyes(entries, plates, cam, parent) {
  if (failed) return;
  plates = plates || [];
  if (!entries.length) {
    if (renderer && lastKey !== "0") {
      for (const eye of eyes) eye.visible = false;
      for (const block of blockers) block.visible = false;
      renderer.clear();
      lastKey = "0";
    }
    return;
  }
  const key = [
    cam.width, cam.height, Math.round(cam.perspective),
    Math.round(cam.x), Math.round(cam.y), Math.round(cam.z),
    cam.yaw.toFixed(1), cam.pitch.toFixed(1),
    ...entries.flatMap((e) => [Math.round(e.x), Math.round(e.y), Math.round(e.z), (+e.gaze).toFixed(1), (+e.pitch).toFixed(1), hueWrap(e.hue)]),
    ...plates.flatMap((p) => [Math.round(p.x), Math.round(p.y), Math.round(p.z), (+p.yaw).toFixed(1)]),
  ].join(",");
  if (key === lastKey && template) return;
  boot(parent);
  if (!renderer) return;
  if (!template) {
    queued = { entries, plates, cam, parent };
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
  while (blockers.length < plates.length) blockers.push(makeBlocker());
  for (let i = 0; i < plates.length; i++) {
    const plate = plates[i];
    const block = blockers[i];
    block.visible = true;
    block.position.set(plate.x, -plate.y, plate.z);
    block.rotation.set(0, (180 - plate.yaw) * RAD, 0);
    block.scale.setScalar(plate.scale || 1);
  }
  for (let i = plates.length; i < blockers.length; i++) blockers[i].visible = false;
  while (eyes.length < entries.length) eyes.push(makeEye());
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const eye = eyes[i];
    eye.visible = true;
    eye.position.set(entry.x, -entry.y, entry.z);
    lookDir(entry.gaze, entry.pitch, _look);
    eye.lookAt(_target.copy(eye.position).add(_look));
    paintHue(eye, entry.hue);
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
  const take = (ink) => {
    let n = 0, sx = 0, sy = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (buf[i + 3] < 30 || !ink(buf[i], buf[i + 1], buf[i + 2])) continue;
        n++; sx += x; sy += h - 1 - y;
      }
    }
    return n ? { x: Math.round(sx / n), y: Math.round(sy / n), n } : null;
  };
  let minX = w, minY = h, maxX = 0, maxY = 0, opaque = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (buf[(y * w + x) * 4 + 3] < 30) continue;
      opaque++;
      const sy = h - 1 - y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }
  }
  const green = (r, g, b) => g > r + 15 && g > b + 8 && g > 30;
  const blue = (r, g, b) => b > r + 15 && b > g + 8 && b > 30;
  return {
    iris: take(green),
    blue: take(blue),
    ball: opaque ? { w: maxX - minX + 1, h: maxY - minY + 1, n: opaque } : null,
  };
}
