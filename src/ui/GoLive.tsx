import { For, Show, createSignal, onMount } from "solid-js";
import { Modal } from "./Modal";
import "./go-live.css";

/** What you chose to share in Go Live. */
export type GoLivePick = {
  /** "screen" or "window": the browser's own picker opens next. "device": a camera, a capture card, OBS's Virtual Camera. */
  kind: "screen" | "window" | "device";
  /** the device's id ("" for a screen or a window) */
  id: string;
  name: string;
  /** "" none, "share" the sound the browser shares with the screen, or a sound input's id (devices) */
  sound: string;
  quality: "720" | "1080" | "source";
  fps: 15 | 30 | 60;
};

/** The picture's size to ask for, or undefined: as large as the source is. */
export const goLiveSize = (quality: GoLivePick["quality"]) =>
  quality === "720" ? { width: 1280, height: 720 } : quality === "1080" ? { width: 1920, height: 1080 } : undefined;

/** Enough for a sharp picture at that size and speed (the desktop app's numbers, lib/ui/go_live.dart). */
export const goLiveBitrate = (pick: Pick<GoLivePick, "quality" | "fps">) =>
  Math.round((pick.quality === "1080" ? 6000 : pick.quality === "source" ? 10000 : 3000) * (pick.fps >= 60 ? 1 : pick.fps >= 30 ? 0.75 : 0.5) * 1000);

const isObs = (name: string) => /\bobs\b/i.test(name);
const isCable = (name: string) => /cable output|vb-audio virtual cable/i.test(name);
const real = (d: MediaDeviceInfo) => Boolean(d.deviceId) && d.deviceId !== "default" && d.deviceId !== "communications";

/**
 * Go Live, the same window as the desktop app's (Kaalob): a screen, an app's
 * window, or a device (OBS's Virtual Camera, a capture card, any camera), with
 * the sound, the resolution and the frame rate you pick. A browser does not
 * let a page list your screens and windows, so for those two the browser's
 * own list opens after Go Live.
 */
export function GoLiveDialog(props: { open: boolean; onClose: () => void; onGo: (pick: GoLivePick) => void }) {
  return (
    <Modal title="› Go Live" class="go-live" open={props.open} onClose={props.onClose}>
      <GoLiveBody onClose={props.onClose} onGo={props.onGo} />
    </Modal>
  );
}

function GoLiveBody(props: { onClose: () => void; onGo: (pick: GoLivePick) => void }) {
  const [tab, setTab] = createSignal<GoLivePick["kind"]>("screen");
  const [cameras, setCameras] = createSignal<MediaDeviceInfo[]>([]);
  const [inputs, setInputs] = createSignal<MediaDeviceInfo[]>([]);
  const [picked, setPicked] = createSignal("");
  /** undefined = the usual for what is picked */
  const [sound, setSound] = createSignal<string | undefined>();
  const [quality, setQuality] = createSignal<GoLivePick["quality"]>("1080");
  const [fps, setFps] = createSignal<GoLivePick["fps"]>(60);
  const [refreshing, setRefreshing] = createSignal(false);

  /** `ask`: the browser hides camera names until it has allowed a camera once, so ask for one. */
  async function load(ask: boolean) {
    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      if (ask && !devices.some((d) => d.kind === "videoinput" && d.label)) {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        probe.getTracks().forEach((track) => track.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
      }
      setCameras(devices.filter((d) => d.kind === "videoinput" && real(d)));
      setInputs(devices.filter((d) => d.kind === "audioinput" && real(d) && d.label));
    } catch {
      /* nothing found: the tab says so */
    }
  }
  onMount(() => void load(false));

  async function refreshNow() {
    if (refreshing()) return;
    setRefreshing(true);
    await load(tab() === "device");
    setRefreshing(false);
  }

  function openTab(next: GoLivePick["kind"]) {
    setTab(next);
    setPicked("");
    setSound(undefined);
    if (next === "device") void load(true);
  }

  const deviceName = () => cameras().find((d) => d.deviceId === picked())?.label || "Camera";
  const ready = () => tab() !== "device" || Boolean(picked());

  const soundChoices = (): [string, string][] =>
    tab() === "device"
      ? [["", "No sound"], ...inputs().map((d): [string, string] => [d.deviceId, d.label])]
      : [
          ["", "No sound"],
          ["share", tab() === "screen" ? "Computer sound (tick the sound box in the browser's list)" : "Its sound (tick the sound box in the browser's list)"],
        ];
  /** the sound that goes with what is picked, unless you choose another */
  const usualSound = () => {
    if (tab() !== "device") return "share";
    // OBS's Virtual Camera is a picture only: its sound, when this computer has a sound input that carries it
    return isObs(deviceName()) ? (inputs().find((d) => isCable(d.label))?.deviceId ?? "") : "";
  };
  const soundNow = () => {
    const chosen = sound() ?? usualSound();
    return soundChoices().some(([id]) => id === chosen) ? chosen : "";
  };

  function go() {
    if (!ready()) return;
    props.onGo({
      kind: tab(),
      id: tab() === "device" ? picked() : "",
      name: tab() === "device" ? deviceName() : tab(),
      sound: soundNow(),
      quality: quality(),
      fps: fps(),
    });
  }

  const chips = <T extends string | number>(label: string, value: () => T, options: [T, string][], pick: (v: T) => void) => (
    <div class="go-live-row">
      <span class="go-live-label">{label}</span>
      <div class="go-live-chips">
        <For each={options}>
          {([v, text]) => (
            <button type="button" class="go-live-chip" aria-pressed={value() === v} onClick={() => pick(v)}>
              {text}
            </button>
          )}
        </For>
      </div>
    </div>
  );

  return (
    <div class="go-live-body">
      <p class="modal-text">Share a screen, an app, or a device (OBS, a capture card, a camera), with its sound.</p>
      <div class="go-live-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab() === "screen"} onClick={() => openTab("screen")}>
          Screens
        </button>
        <button type="button" role="tab" aria-selected={tab() === "window"} onClick={() => openTab("window")}>
          Applications
        </button>
        <button type="button" role="tab" aria-selected={tab() === "device"} onClick={() => openTab("device")}>
          Devices ({cameras().length})
        </button>
        <span class="go-live-space" />
        {/* looks again: a device just plugged in, OBS's Virtual Camera just started */}
        <button type="button" class="go-live-refresh" title="Look again for devices" disabled={refreshing()} onClick={() => void refreshNow()}>
          {refreshing() ? "Looking…" : "↻ Refresh"}
        </button>
      </div>

      <div class="go-live-grid">
        <Show
          when={tab() === "device"}
          fallback={
            <button type="button" class="go-live-card wide" aria-pressed="true" onDblClick={go}>
              <span class="go-live-thumb" aria-hidden="true">
                {tab() === "screen" ? "▭" : "❐"}
              </span>
              <span class="go-live-name">{tab() === "screen" ? "A screen" : "An app's window"}</span>
              <small>
                Press Go Live. Your browser then shows its own list of your {tab() === "screen" ? "screens" : "open windows"}: pick one there.
              </small>
            </button>
          }
        >
          <Show
            when={cameras().length}
            fallback={<p class="go-live-empty">No cameras or capture devices found. For OBS, press Start Virtual Camera in OBS, then Refresh.</p>}
          >
            <For each={cameras()}>
              {(d) => (
                <button
                  type="button"
                  class="go-live-card"
                  aria-pressed={picked() === d.deviceId}
                  onClick={() => {
                    setPicked(d.deviceId);
                    setSound(undefined);
                  }}
                  onDblClick={() => {
                    setPicked(d.deviceId);
                    go();
                  }}
                >
                  <span class="go-live-thumb" aria-hidden="true">
                    {isObs(d.label) ? "◉" : "◎"}
                  </span>
                  <span class="go-live-name">{d.label || "Camera"}</span>
                </button>
              )}
            </For>
          </Show>
        </Show>
      </div>

      {/* the sound: none, the one the browser shares with the screen, or a sound input for a device */}
      <label class="go-live-row">
        <span class="go-live-label">Sound</span>
        <select class="go-live-select" value={soundNow()} onChange={(e) => setSound(e.currentTarget.value)}>
          <For each={soundChoices()}>{([id, label]) => <option value={id}>{label}</option>}</For>
        </select>
      </label>
      {chips<GoLivePick["quality"]>("Resolution", quality, [["720", "720p"], ["1080", "1080p"], ["source", "Source"]], setQuality)}
      {chips<GoLivePick["fps"]>("Frame rate", fps, [[15, "15 fps"], [30, "30 fps"], [60, "60 fps"]], setFps)}

      <div class="modal-actions">
        <button type="button" class="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" class="btn primary" disabled={!ready()} onClick={go}>
          Go Live
        </button>
      </div>
    </div>
  );
}
