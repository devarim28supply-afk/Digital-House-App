import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import * as THREE from "three";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import type { Track } from "livekit-client";
import { setLivingRoomTvBottom, setTvRemoteAvailable, tvRemoteOpen } from "../data/where";
import { type Channel, setLivingRoomLights } from "../data/store";

const DEFAULT_LIGHTS: NonNullable<Channel["lrLights"]> = {
  backlightOn: false,
  roomLightsOn: true,
  blColor: "#66aaff",
  blOpacity: 10,
};

/**
 * Living Room's big panel: a real 3D room (not a flat video tile) — the
 * CamDisplay plaster wall, the same cement floor, a wall-mounted TV with a
 * real RectAreaLight backlight, and soft shadows. The TV's screen shows
 * whoever's Stream (webcam or OBS) is on, as a real video texture, fed by
 * the same LiveKit track the flat Wall Street panel uses (BroadcastVideo) —
 * this doesn't pick its own camera, it just renders what's already chosen.
 *
 * Ported from the design sandbox (design/living-room-3d/main.js), where
 * every constant below (TV size/position, backlight placement and
 * strength, the floor-glow decoy light, the locked camera angle) was
 * dialed in live and confirmed working. Camera stays fixed/locked, same as
 * the sandbox — no orbit controls, nothing to drag.
 */

const ROOM_W = 5.467082;
const ROOM_H = 3.4;
const HALF = ROOM_W / 2;
const BACKDROP_W = ROOM_W * 2.0;
const BACKDROP_H = ROOM_H * 1.6;

const TV_W = 3.2 * 1.5;
const TV_H = 1.8 * 1.5;
const TV_Y = 1.65;
const TV_Y_OFFSET = 0.35;
const TV_STANDOFF = 0.15;

const LOCKED_HEIGHT = -0.13;
const LOCKED_SIGHT = -0.01;

const BACKLIGHT_COLOR = 0x66aaff;
const FLOOR_GLOW_LOCKED = { x: 0.01, y: 0.62, z: 0.1, size: 1.47, strength: 0.2 };
const FLOOR_GLOW_RATIO = FLOOR_GLOW_LOCKED.strength / 10;
const FLOOR_GLOW_W = TV_W * 0.7 * FLOOR_GLOW_LOCKED.size;
const FLOOR_GLOW_H = 1.1 * FLOOR_GLOW_LOCKED.size;

/**
 * Direct port of CamDisplay's makeWallTextures() (D:\Projects\CamDisplay\
 * src\main.js ~line 177): 900 small soft random circular bumps baked into
 * a normal map + roughness map on a 256px tile, repeated across the wall —
 * a real bump relief lit by actual scene lights, not a decal.
 */
function makeWallTextures(renderer: THREE.WebGLRenderer) {
  const size = 256;
  const height = new Float32Array(size * size);
  for (let i = 0; i < 900; i++) {
    const cx = Math.random() * size;
    const cy = Math.random() * size;
    const r = 1 + Math.random() * 3.5;
    const amp = (Math.random() - 0.5) * 0.6;
    const r2 = r * r;
    const minX = Math.max(0, Math.floor(cx - r));
    const maxX = Math.min(size - 1, Math.ceil(cx + r));
    const minY = Math.max(0, Math.floor(cy - r));
    const maxY = Math.min(size - 1, Math.ceil(cy + r));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx, dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= r2) height[y * size + x] += amp * (1 - d2 / r2);
      }
    }
  }

  let hMin = Infinity, hMax = -Infinity;
  for (const h of height) {
    if (h < hMin) hMin = h;
    if (h > hMax) hMax = h;
  }
  const hRange = hMax - hMin || 1;

  const normalCanvas = document.createElement("canvas");
  normalCanvas.width = normalCanvas.height = size;
  const nCtx = normalCanvas.getContext("2d")!;
  const nImg = nCtx.createImageData(size, size);

  const roughCanvas = document.createElement("canvas");
  roughCanvas.width = roughCanvas.height = size;
  const rCtx = roughCanvas.getContext("2d")!;
  const rImg = rCtx.createImageData(size, size);

  const strength = 3.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = (x - 1 + size) % size, x1 = (x + 1) % size;
      const y0 = (y - 1 + size) % size, y1 = (y + 1) % size;
      const hL = height[y * size + x0], hR = height[y * size + x1];
      const hD = height[y0 * size + x], hU = height[y1 * size + x];
      const nx = (hL - hR) * strength, ny = (hD - hU) * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      nImg.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      nImg.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      nImg.data[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      nImg.data[i + 3] = 255;

      const norm = (height[y * size + x] - hMin) / hRange;
      const rough = Math.round((0.82 + norm * 0.18) * 255);
      rImg.data[i] = rough;
      rImg.data[i + 1] = rough;
      rImg.data[i + 2] = rough;
      rImg.data[i + 3] = 255;
    }
  }
  nCtx.putImageData(nImg, 0, 0);
  rCtx.putImageData(rImg, 0, 0);

  const normalMap = new THREE.CanvasTexture(normalCanvas);
  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  for (const tex of [normalMap, roughnessMap]) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(22, 11);
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  }
  return { normalMap, roughnessMap };
}

export function LivingRoomBroadcast(props: { track: () => Track | undefined; serverId: string; channel: Channel }) {
  let host: HTMLDivElement | undefined;
  // The renderer's canvas is appended imperatively (outside Solid's own
  // reconciliation) into its own dedicated child div, kept separate from
  // the <Show> below - sharing one parent with a reactively toggled
  // sibling let Solid's own insert/remove bookkeeping for the Show
  // occasionally carry off the canvas along with it (the TV remote
  // button closing the panel was silently wiping the 3D scene from the
  // page, with no thrown error, because it shared `host` with the panel).
  let canvasHost: HTMLDivElement | undefined;

  // The TV remote (header button, Shell.tsx) - backlight color/opacity,
  // room lights. Same iPad-styled panel as the design sandbox
  // (design/living-room-3d), minus its "Connect TV" entry - the real app
  // already has a working webcam/OBS picker (the Stream button), so a
  // second one here would just be a confusing duplicate.
  //
  // Shared live across everyone in the call: the state lives on the
  // channel doc (lrLights, store.ts's setLivingRoomLights), which every
  // client already watches in real time (watchChannels). Local signals
  // mirror it for instant feedback on your own click/drag instead of
  // waiting a round trip, then reconcile the moment Firestore's own
  // update comes back (from you or anyone else) - closing the remote
  // never touches this state, so it's exactly where the room left it.
  setTvRemoteAvailable(true);
  onCleanup(() => {
    setTvRemoteAvailable(false);
  });
  const remote = () => props.channel.lrLights ?? DEFAULT_LIGHTS;
  const [backlightOn, setBacklightOnLocal] = createSignal(remote().backlightOn);
  const [roomLightsOn, setRoomLightsOnLocal] = createSignal(remote().roomLightsOn);
  const [blColor, setBlColorLocal] = createSignal(remote().blColor);
  const [blOpacity, setBlOpacityLocal] = createSignal(remote().blOpacity);
  createEffect(() => {
    const r = remote();
    setBacklightOnLocal(r.backlightOn);
    setRoomLightsOnLocal(r.roomLightsOn);
    setBlColorLocal(r.blColor);
    setBlOpacityLocal(r.blOpacity);
  });
  function pushLights(patch: Partial<NonNullable<Channel["lrLights"]>>) {
    const current = {
      backlightOn: backlightOn(),
      roomLightsOn: roomLightsOn(),
      blColor: blColor(),
      blOpacity: blOpacity(),
    };
    void setLivingRoomLights(props.serverId, props.channel.id, { ...current, ...patch });
  }
  function setBacklightOn(v: boolean) {
    setBacklightOnLocal(v);
    pushLights({ backlightOn: v });
  }
  function setRoomLightsOn(v: boolean) {
    setRoomLightsOnLocal(v);
    pushLights({ roomLightsOn: v });
  }
  function setBlColor(v: string) {
    setBlColorLocal(v);
    pushLights({ blColor: v });
  }
  // The opacity slider fires on every drag tick - optimistic locally,
  // but debounced to Firestore so dragging doesn't spam writes.
  let opacityWrite = 0;
  function setBlOpacity(v: number) {
    setBlOpacityLocal(v);
    window.clearTimeout(opacityWrite);
    opacityWrite = window.setTimeout(() => pushLights({ blOpacity: v }), 150);
  }
  onCleanup(() => window.clearTimeout(opacityWrite));

  onMount(() => {
    const el = canvasHost;
    if (!el) return;

    RectAreaLightUniformsLib.init();

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050505);

    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);

    // ---- plaster wall ----------------------------------------------------
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0xe9e4db,
      roughness: 0.95,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    const { normalMap, roughnessMap } = makeWallTextures(renderer);
    wallMat.normalMap = normalMap;
    wallMat.normalScale = new THREE.Vector2(0.55, 0.55);
    wallMat.roughnessMap = roughnessMap;

    const wall = new THREE.Mesh(new THREE.PlaneGeometry(BACKDROP_W, BACKDROP_H), wallMat);
    wall.position.set(0, ROOM_H / 2, -HALF);
    wall.receiveShadow = true;
    scene.add(wall);

    // ---- floor -------------------------------------------------------
    const floorMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.0, color: 0xbbbbbb });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(BACKDROP_W, BACKDROP_W), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, HALF - ROOM_W / 2);
    floor.receiveShadow = true;
    scene.add(floor);
    const floorTexLoader = new THREE.TextureLoader();
    floorTexLoader.load(`${import.meta.env.BASE_URL}textures/floor-gray-cement.jpg`, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      // The source photo had a visible lighter border framing its edges
      // (public/textures/floor-gray-cement.jpg is now a cropped copy with
      // that border removed) - every tile boundary showed it as a seam
      // line no matter the repeat count or wrap mode, since the border
      // itself was the mismatch, not the tiling technique. Mirrored
      // wrapping (not a plain repeat) on top of the cropped image for
      // genuinely seamless pixel-for-pixel edges.
      tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping;
      tex.repeat.set(4, 4);
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      floorMat.map = tex;
      floorMat.color.set(0xffffff);
      floorMat.needsUpdate = true;
    });

    // ---- baseboard ------------------------------------------------------
    const baseboard = new THREE.Mesh(
      new THREE.BoxGeometry(BACKDROP_W, 0.12, 0.02),
      new THREE.MeshStandardMaterial({ color: 0xfdfcfa, roughness: 0.5 }),
    );
    baseboard.position.set(0, 0.06, -HALF + 0.011);
    baseboard.receiveShadow = true;
    scene.add(baseboard);

    // ---- TV --------------------------------------------------------------
    const tvGroup = new THREE.Group();
    tvGroup.position.set(0, TV_Y + TV_Y_OFFSET, -HALF + TV_STANDOFF);
    scene.add(tvGroup);

    const tvBody = new THREE.Mesh(
      new THREE.BoxGeometry(TV_W, TV_H, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.4, metalness: 0.3 }),
    );
    tvBody.castShadow = true;
    tvGroup.add(tvBody);

    // Unlit — a real screen emits its own light, reading the same
    // regardless of the room's own lighting.
    const screenMat = new THREE.MeshBasicMaterial({ color: 0x05070a });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(TV_W - 0.06, TV_H - 0.06), screenMat);
    screen.position.z = 0.031;
    tvGroup.add(screen);

    // ---- backlight (CamDisplay technique) --------------------------------
    // Intensity starts at 0 (off, matching backlightOn's default) - the
    // createEffect below drives it live from the remote panel instead of
    // a fixed constant.
    const tvBacklight = new THREE.RectAreaLight(BACKLIGHT_COLOR, 0, TV_W, TV_H);
    tvBacklight.position.set(0, TV_Y + TV_Y_OFFSET, -HALF + TV_STANDOFF * 0.4);
    tvBacklight.lookAt(0, TV_Y + TV_Y_OFFSET, -HALF);
    scene.add(tvBacklight);

    const tvFloorGlow = new THREE.RectAreaLight(BACKLIGHT_COLOR, 0, FLOOR_GLOW_W, FLOOR_GLOW_H);
    tvFloorGlow.position.set(FLOOR_GLOW_LOCKED.x, FLOOR_GLOW_LOCKED.y, -HALF + FLOOR_GLOW_LOCKED.z);
    tvFloorGlow.rotation.x = -Math.PI / 2; // lookAt() straight down is a degenerate case; a direct rotation isn't
    scene.add(tvFloorGlow);

    // ---- room lights -------------------------------------------------
    const hemi = new THREE.HemisphereLight(0xffffff, 0x1a1a1a, 0.55);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 0.55);
    key.position.set(2.5, 4, 3.5);
    key.target.position.set(0, TV_Y, -HALF);
    scene.add(key.target);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.radius = 4;
    key.shadow.bias = -0.0005;
    key.shadow.camera.left = -4;
    key.shadow.camera.right = 4;
    key.shadow.camera.top = 4;
    key.shadow.camera.bottom = -4;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 15;
    key.shadow.camera.updateProjectionMatrix();
    scene.add(key);
    const fill = new THREE.AmbientLight(0xffffff, 0.08);
    scene.add(fill);

    // Backlight color/opacity and Room light on/off, driven live by the
    // TV remote panel - same technique as the design sandbox's
    // applyLights(), just as a Solid effect instead of raw DOM listeners.
    createEffect(() => {
      const on = roomLightsOn();
      hemi.intensity = on ? 0.55 : 0.02;
      key.intensity = on ? 0.55 : 0.0;
      fill.intensity = on ? 0.08 : 0.01;
      const bg = on ? 0.02 : 0.004;
      scene.background = new THREE.Color(bg, bg, bg);
    });
    createEffect(() => {
      const color = blColor();
      tvBacklight.color.set(color);
      tvFloorGlow.color.set(color);
    });
    createEffect(() => {
      const on = backlightOn();
      const opacity = blOpacity();
      tvBacklight.intensity = on ? opacity : 0;
      tvFloorGlow.intensity = on ? opacity * FLOOR_GLOW_RATIO : 0;
    });

    // ---- locked camera -----------------------------------------------
    camera.position.set(0, TV_Y + LOCKED_HEIGHT, 1.1);
    camera.lookAt(0, TV_Y + LOCKED_HEIGHT + LOCKED_SIGHT, -HALF + TV_STANDOFF);

    // Where the TV's own bottom edge actually lands on screen, so the
    // webcam row (positioned from VoiceRoom.tsx/phoneCallLayout.ts) can
    // park itself right below it instead of a fixed pixel guess - the
    // projected position moves with the container's aspect ratio, a fixed
    // offset doesn't, and drifted into covering the screen on a window
    // size it wasn't tuned against.
    const tvBottomWorld = new THREE.Vector3(0, TV_Y + TV_Y_OFFSET - TV_H / 2, -HALF + TV_STANDOFF);
    function updateTvBottomFraction() {
      const ndc = tvBottomWorld.clone().project(camera);
      setLivingRoomTvBottom(Math.min(1, Math.max(0, (1 - ndc.y) / 2)));
    }

    // ---- resize to the host element, not the window ----------------------
    function resize() {
      const w = el!.clientWidth || 1;
      const h = el!.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
      updateTvBottomFraction();
    }
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(el);

    let raf = 0;
    (function animate() {
      raf = requestAnimationFrame(animate);
      renderer.render(scene, camera);
    })();

    // ---- the Stream track, as a video texture on the TV's screen --------
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    let videoTexture: THREE.VideoTexture | undefined;
    let attachedTrack: Track | undefined;

    createEffect(() => {
      const track = props.track();
      if (attachedTrack && attachedTrack !== track) attachedTrack.detach(video);
      attachedTrack = track;
      if (!track) {
        screenMat.map = null;
        screenMat.color.set(0x05070a);
        screenMat.needsUpdate = true;
        return;
      }
      track.attach(video);
      if (!videoTexture) {
        videoTexture = new THREE.VideoTexture(video);
        videoTexture.colorSpace = THREE.SRGBColorSpace;
      }
      screenMat.map = videoTexture;
      screenMat.color.set(0xffffff);
      screenMat.needsUpdate = true;
    });

    onCleanup(() => {
      resizeObserver.disconnect();
      cancelAnimationFrame(raf);
      attachedTrack?.detach(video);
      videoTexture?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
    });
  });

  return (
    <div class="living-room-3d" ref={host}>
      <div class="living-room-3d-canvas" ref={canvasHost} />
      <Show when={tvRemoteOpen()}>
        <div class="lr-remote">
          <div class="lr-remote-screen">
            <div class="lr-remote-title">Remote</div>
            <div class="lr-remote-row">
              <button
                type="button"
                class="lr-remote-app"
                aria-pressed={backlightOn()}
                onClick={() => setBacklightOn(!backlightOn())}
              >
                <span class="ico">💡</span>
                <span>{backlightOn() ? "Backlight on" : "Backlight"}</span>
              </button>
              <button
                type="button"
                class="lr-remote-app"
                aria-pressed={roomLightsOn()}
                onClick={() => setRoomLightsOn(!roomLightsOn())}
              >
                <span class="ico">🏠</span>
                <span>{roomLightsOn() ? "Room light" : "Lights off"}</span>
              </button>
            </div>
            <div class="lr-remote-section">
              <label>Backlight color &amp; opacity</label>
              <div class="lr-remote-section-row">
                <input
                  type="color"
                  value={blColor()}
                  onInput={(e) => setBlColor(e.currentTarget.value)}
                />
                <input
                  type="range"
                  min="0"
                  max="20"
                  step="0.1"
                  value={blOpacity()}
                  onInput={(e) => setBlOpacity(Number(e.currentTarget.value))}
                />
              </div>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
