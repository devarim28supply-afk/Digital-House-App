import { bindCallControls, deafened, toggleMicrophone } from "../data/callControls";
import { DeveloperBadge } from "./DeveloperBadge";
import { For, type JSX, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";

import {
  type LocalParticipant,
  type LocalTrackPublication,
  type Participant,
  type RemoteTrack,
  Room,
  RoomEvent,
  Track,
  type TrackPublication,
  type TrackPublishOptions,
  type VideoCaptureOptions,
  VideoPresets,
} from "livekit-client";

import { type SeatControl, startSeats } from "../data/seats";
import { displayName, type Channel, type Profile } from "../data/store";
import { setCallFaces } from "../data/callFaces";
import { audit } from "../data/audit";
import { canRemoveFromCall, setInCall, setStreamingIn, setWatchRequest, watchRequest } from "../data/where";
import { auth } from "../firebase";
import { Modal } from "./Modal";
import { faceStyle, faceText } from "./Shell";
import { type PipSpot, type ShareView, broadcastPlan, deskPlan, phonePlan, phoneSharePlaces, pipSpotAt, shareSwipeTarget } from "./phoneCallLayout";
import { LivingRoomBroadcast } from "./LivingRoomBroadcast";

/** A pass for this channel's LiveKit room, checked against Firestore. */
export async function fetchPass(serverId: string, channelId: string, wall = false) {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error("Log in first.");
  const res = await fetch("/api/dh-token", {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, channelId, wall }),
  });
  const body = (await res.json().catch(() => ({}))) as { url?: string; token?: string; error?: string };
  if (!res.ok || !body.url || !body.token) throw new Error(body.error || "Could not join the call.");
  return { url: body.url, token: body.token };
}

/** Disconnect one person from this channel's call (the server's owner and admins; the server checks). */
export async function removeFromCall(serverId: string, channelId: string, identity: string) {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error("Log in first.");
  const res = await fetch("/api/dh-remove", {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, channelId, identity }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || "Could not remove them.");
  }
}

/** How long a camera start or stop may take before the button stops waiting. */
const CAMERA_TIMEOUT_MS = 10_000;

type TileInfo = {
  key: string;
  participant: Participant;
  publication?: TrackPublication;
  screen: boolean;
  /** the sharer's 2nd screen */
  second?: boolean;
  /** the Stream menu: a second webcam, shown as its own screen */
  streamCam?: boolean;
};

// A 2nd shared screen rides its own named track: LiveKit keeps one
// "screen share" per person, so this one is published beside it.
const SECOND_SCREEN = "screen-2";
// The Stream menu. A second webcam, shown on the primary webcam tile. Not a screen share.
const STREAM_CAM = "webcam-2";
// Stream mode (Kaalob): still a screen share, but it rides on the sharer's
// own tile as a small picture instead of a tile of its own.
const STREAM = "stream";
const STREAM_AUDIO = "stream-audio";
// While gaming, the PC and the upload are stretched (Kaalob's webcam got slow).
// The webcam keeps its frame rate (signing needs smooth motion more than
// sharpness) and goes first; the stream gives way.
const CAMERA_PUBLISH: TrackPublishOptions = {
  degradationPreference: "maintain-framerate",
  // 1 Mbps is plenty for signing; a home upload (Kaalob's measured ~2 Mbps
  // while streaming) cannot carry much more next to a stream
  videoEncoding: { maxBitrate: 1_000_000, maxFramerate: 30, priority: "high" },
};
// LiveKit's default camera is an exact 1280×720. Held upright, a phone's
// sensor is 9:16, the same shape as the tall tile - an ideal size was
// ignored and the camera stayed wide, so exact aspect is required and
// crop-and-scale reaches it from the sensor. Turned on its side, the same
// phone is a 16:9 tile, like a desktop's - phoneLandscape() tracks which
// way it is held right now (screen.orientation, where it exists), and
// every request below targets whichever shape that is, not always 9:16.
const PHONE_ASPECT = 9 / 16;
const PHONE_ASPECT_WIDE = 16 / 9;
function phoneLandscape(): boolean {
  if (typeof screen !== "undefined" && screen.orientation?.type) {
    return screen.orientation.type.startsWith("landscape");
  }
  if (typeof window === "undefined") return false;
  return window.innerWidth > window.innerHeight;
}
function phoneAspect(): number {
  return phoneLandscape() ? PHONE_ASPECT_WIDE : PHONE_ASPECT;
}
function phoneCameraCapture(loose = false): VideoCaptureOptions | undefined {
  if (typeof window === "undefined" || !COARSE_POINTER) return undefined;
  if (Math.min(window.innerWidth, window.innerHeight) >= PHONE_SHORT) return undefined;
  const wide = phoneLandscape();
  const short = loose ? 720 : 1080;
  const long = loose ? 1280 : 1920;
  return {
    aspectRatio: loose ? { ideal: phoneAspect() } : { exact: phoneAspect() },
    resizeMode: "crop-and-scale",
    resolution: {
      width: { ideal: wide ? long : short } as unknown as number,
      height: { ideal: wide ? short : long } as unknown as number,
      frameRate: { ideal: 30, max: 30 } as unknown as number,
    },
  } as VideoCaptureOptions;
}
function matchesAspect(width: number, height: number, aspect: number): boolean {
  if (width <= 0 || height <= 0) return false;
  return Math.abs(width / height - aspect) < 0.06;
}
function settingsSize(media: MediaStreamTrack): { width: number; height: number } {
  const settings = media.getSettings();
  return { width: settings.width ?? 0, height: settings.height ?? 0 };
}
/** The frame the tile draws. getSettings() can still be the sideways sensor. */
async function shownSize(media: MediaStreamTrack): Promise<{ width: number; height: number }> {
  const fallback = settingsSize(media);
  if (typeof document === "undefined") return fallback;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([media]);
  try {
    await video.play().catch(() => undefined);
    const sawFrame = await new Promise<boolean>((resolve) => {
      if (typeof video.requestVideoFrameCallback === "function") {
        video.requestVideoFrameCallback(() => resolve(true));
      } else {
        video.addEventListener("loadeddata", () => resolve(true), { once: true });
      }
      window.setTimeout(() => resolve(false), 400);
    });
    if (sawFrame && video.videoWidth > 0 && video.videoHeight > 0) {
      return { width: video.videoWidth, height: video.videoHeight };
    }
  } finally {
    video.pause();
    video.srcObject = null;
  }
  return fallback;
}
/** Does the live frame already match how the phone is held right now? */
async function shownMatchesHeld(media: MediaStreamTrack): Promise<boolean> {
  const target = phoneAspect();
  const settings = settingsSize(media);
  if (matchesAspect(settings.width, settings.height, target)) return true;
  const shown = await shownSize(media);
  return matchesAspect(shown.width, shown.height, target);
}
function phoneLockConstraints(): MediaTrackConstraints {
  const wide = phoneLandscape();
  return {
    width: { ideal: wide ? 1920 : 1080 },
    height: { ideal: wide ? 1080 : 1920 },
    aspectRatio: { exact: phoneAspect() },
    resizeMode: "crop-and-scale",
    frameRate: { ideal: 30, max: 30 },
  } as MediaTrackConstraints;
}
/** The camera opened the wrong way round. Ask again until the frame matches how the phone is held. */
async function widenPhoneCamera(active: LocalParticipant) {
  if (!phoneCameraCapture()) return;
  const local = active.getTrackPublication(Track.Source.Camera)?.track;
  const media = local?.mediaStreamTrack;
  if (!media || media.readyState !== "live") return;
  if (await shownMatchesHeld(media)) return;
  const wide = phoneLandscape();
  try {
    await media.applyConstraints(phoneLockConstraints());
  } catch {
    /* an exact pixel size below asks again */
  }
  if (await shownMatchesHeld(media)) return;
  const sizes: [number, number][] = wide ? [[1920, 1080], [1280, 720]] : [[1080, 1920], [720, 1280]];
  for (const [width, height] of sizes) {
    try {
      await media.applyConstraints({
        width: { exact: width },
        height: { exact: height },
        resizeMode: "crop-and-scale",
        frameRate: { ideal: 30, max: 30 },
      } as MediaTrackConstraints);
    } catch {
      continue;
    }
    if (await shownMatchesHeld(media)) return;
  }
  // A phone that applies aspect in sensor space, then rotates, hands back the
  // opposite shape from the one asked for. Ask for that shape instead.
  const shown = await shownSize(media);
  const opposite = wide ? PHONE_ASPECT : PHONE_ASPECT_WIDE;
  if (matchesAspect(shown.width, shown.height, opposite)) {
    try {
      await media.applyConstraints({
        width: { ideal: wide ? 1080 : 1920 },
        height: { ideal: wide ? 1920 : 1080 },
        aspectRatio: { exact: opposite },
        resizeMode: "crop-and-scale",
        frameRate: { ideal: 30, max: 30 },
      } as MediaTrackConstraints);
    } catch {
      /* put the direct request back below */
    }
    if (await shownMatchesHeld(media)) return;
    try {
      await media.applyConstraints(phoneLockConstraints());
    } catch {
      /* the picture already publishing stays */
    }
    if (await shownMatchesHeld(media)) return;
  }
  const restart = local as { restartTrack?: (options?: VideoCaptureOptions) => Promise<void> };
  if (!restart.restartTrack) return;
  try {
    await restart.restartTrack(phoneCameraCapture());
  } catch {
    /* the picture already publishing stays */
  }
}
const STREAM_CAM_PUBLISH: TrackPublishOptions = {
  name: STREAM_CAM,
  source: Track.Source.Unknown,
  simulcast: false,
  degradationPreference: "maintain-framerate",
  videoEncoding: { maxBitrate: 700_000, maxFramerate: 30, priority: "low" },
};
// Stream mode is one capture. A small copy goes with it for the LIVE tile previews.
const STREAM_SIZE = { width: 1920, height: 1080, maxBitrate: 3_000_000, layers: [VideoPresets.h360] };
// Attention (Kaalob, Deaf-first): your tile strobes white for everyone, 3 s.
const ATTENTION_TOPIC = "attention";
const TEAM_TOPIC = "dh-team";
const ATTENTION_MS = 3000;
type InsetCorner = "tl" | "tr" | "bl" | "br";
// the small picture's width, in % of its tile: from this big down to this small
const INSET_MAX = 30;
const INSET_MIN = 12;

// the call grid: gap between tiles, and the small Room view's width (of a tile)
const GAP = 10;
// A phone's short side. Desktop windows are not phones, even when narrow.
const PHONE_SHORT = 540;
const COARSE_POINTER = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
// Wall Street (store.ts's WALL_STREET_TILE.roomKey): one fixed host - whoever
// joined the call first - permanently big, everyone else a small column,
// never the adaptive grid. Read off props.channel directly rather than a new
// prop, so this stays entirely inside VoiceRoom/phoneCallLayout.ts.
const WALL_STREET_ROOMKEY = "darkwood-wall-street";
// Living Room (store.ts's LIVING_ROOM_TILE.roomKey): the same fixed big
// panel + webcam row as Wall Street, but its panel is Stream only - no
// TradingView, so no Chart tab (see showChartTab() below).
const LIVING_ROOM_ROOMKEY = "darkwood-living-room";
const BROADCAST_ROOMKEYS = new Set([WALL_STREET_ROOMKEY, LIVING_ROOM_ROOMKEY]);
const isBroadcastRoom = (roomKey?: string) => Boolean(roomKey && BROADCAST_ROOMKEYS.has(roomKey));
const SMALL_ROOM_VIEW = 0.4;
// double-click layout: this many small screens in the row under the big one
const SPOT_ROW_MAX = 4;

/** Where a Gestr room's live camera is watched from (store.roomCamOf). */
/** wide: spans the call like a shared screen; otherwise a normal tile. */
export type RoomViewSource = { tokenUrl: string; room: string; username: string; wide: boolean };

// The same shape the rooms give a name (their token servers check it).
const roomName = (raw: string) => raw.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 32);

/**
 * Watch the 3D room's camera: a hidden, watch-only connection to the room's
 * own LiveKit media room, picking up its "roomcam" track. Someone standing in
 * the room streams it; with nobody there, there is no track and no Room view.
 */
// One watcher name per screen: two screens (or a quick rejoin) under the same
// name would knock each other out of the call.
const WATCH_TAG = Math.random().toString(36).slice(2, 8);

/**
 * The same watcher also picks up the webcams ("facecam") of the people
 * standing in the 3D room, so the videochat sees them too: onFace(name,
 * track) as they come and go (track undefined when gone).
 */
async function watchRoomCam(
  source: RoomViewSource,
  onTrack: (track: RemoteTrack | undefined) => void,
  onDropped: () => void,
  onFace: (name: string, track: RemoteTrack | undefined) => void,
) {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) return undefined;
  const params = new URLSearchParams({
    identity: `${roomName(source.username)}~peek-${WATCH_TAG}`,
    room: source.room,
    peek: "1",
  });
  const res = await fetch(`${source.tokenUrl}?${params}`, { headers: { Authorization: `Bearer ${idToken}` } });
  const body = (await res.json().catch(() => ({}))) as { url?: string; token?: string };
  if (!res.ok || !body.url || !body.token) return undefined;
  const watcher = new Room({ adaptiveStream: true });
  watcher
    .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub, participant) => {
      if (pub.trackName === "roomcam") onTrack(track);
      else if (pub.trackName === "facecam" && track.kind === Track.Kind.Video) onFace(participant.identity, track);
    })
    .on(RoomEvent.TrackUnsubscribed, (_track: RemoteTrack, pub, participant) => {
      if (pub.trackName === "roomcam") onTrack(undefined);
      else if (pub.trackName === "facecam") onFace(participant.identity, undefined);
    })
    .on(RoomEvent.ParticipantDisconnected, (participant) => onFace(participant.identity, undefined))
    .on(RoomEvent.Disconnected, () => {
      onTrack(undefined);
      onDropped();
    });
  await watcher.connect(body.url, body.token);
  return watcher;
}

/**
 * A voice/video channel. Join (or autoJoin, when the app opens it as your
 * call) connects; the mic and camera start off until you switch them on.
 */

type CamChoice = { id: string; label: string };

/** Windows lists one camera again as "Default - …" and "Communications - …". */
function bareCameraLabel(label: string) {
  return label.replace(/^(Default|Communications) - /i, "").trim();
}

/** The real webcams. The Default and Communications entries are the same cameras again. */
function listedCameras(devices: MediaDeviceInfo[]): CamChoice[] {
  return devices
    .filter((d) => d.kind === "videoinput" && d.deviceId !== "" && d.deviceId !== "default" && d.deviceId !== "communications")
    .map((d, i) => ({ id: d.deviceId, label: bareCameraLabel(d.label) || `Webcam ${i + 1}` }));
}

function savedStreamCam() {
  try {
    return localStorage.getItem("dh_webcam_2") || "";
  } catch {
    return "";
  }
}

function rememberStreamCam(id: string) {
  try {
    localStorage.setItem("dh_webcam_2", id);
  } catch {
    /* private mode */
  }
}

/** The webcam the browser calls Default. That one stays the primary camera. */
function primaryCameraId(devices: MediaDeviceInfo[]) {
  const fallback = devices.find((d) => d.kind === "videoinput" && d.deviceId === "default");
  const bare = bareCameraLabel(fallback?.label ?? "");
  const real = devices.find(
    (d) =>
      d.kind === "videoinput" &&
      d.deviceId !== "" &&
      d.deviceId !== "default" &&
      d.deviceId !== "communications" &&
      bare !== "" &&
      bareCameraLabel(d.label) === bare,
  );
  return real?.deviceId ?? "";
}

function screenLabel(tile: { second?: boolean; streamCam?: boolean }) {
  if (tile.streamCam) return "stream";
  if (tile.second) return "2nd screen";
  return "screen";
}

export function VoiceRoom(props: {
  serverId: string;
  channel: Channel;
  uid: string;
  name: string;
  profiles: Map<string, Profile>;
  /** join straight away (the room wall) instead of waiting for Join */
  autoJoin?: boolean;
  /** told about the live call, so the wall can publish the room's camera */
  onRoom?: (room: Room | undefined) => void;
  /** replaces the Camera button (the wall asks the room for its camera) */
  camera?: { on: boolean; toggle: () => void };
  /**
   * The 3D room's live camera as a "Room view" screen in this call. Only the
   * tile's videochat in Darkwood Node passes it, never the wall in the room.
   */
  roomView?: RoomViewSource;
  /** the room's wall: room webcams from roomView, but never the Room view itself */
  noRoomViewTile?: boolean;
  /**
   * The wall in a 3D room: watch the call only (an invisible, watch-only
   * pass under its own name), no tile for yourself, no buttons.
   */
  viewOnly?: boolean;
  /** teamed-up streamers in this call (uids): one screen per team, rotating every 10 s */
  teams?: string[][];
  /** Disconnect: the app hangs up its one call (it keeps the call alive across channels) */
  onLeave?: () => void;
  /**
   * The tile's Darkwood Room: this call hands out its four desks (data/seats),
   * and the room page asks it to sit, stand, and turn the camera or the
   * screen share on and off (one camera and one share for both).
   */
  seats?: boolean;
  /**
   * Operation Room: mic and camera only. The window is the view, so this
   * call's own tiles stay hidden, and Share screen and Stream are not here.
   */
  webcamOnly?: boolean;
}) {
  const [room, setRoom] = createSignal<Room | undefined>();
  const [roomCamTrack, setRoomCamTrack] = createSignal<RemoteTrack | undefined>();
  // Wall Street's layout is fixed (broadcastPlan, below) - a screen share
  // would have nowhere defined to go in it, so it's off there the same way
  // it's off for webcamOnly (the Operation Room).
  const noShare = () => props.webcamOnly || isBroadcastRoom(props.channel.roomKey);
  // Hide / show the Room view, remembered per tile.
  const hiddenKey = () => `dh_roomview_hidden_${props.channel.id}`;
  const readHidden = () => {
    try {
      return localStorage.getItem(hiddenKey()) === "1";
    } catch {
      return false;
    }
  };
  const [roomViewHidden, setRoomViewHidden] = createSignal(readHidden());
  createEffect(on(() => props.channel.id, () => setRoomViewHidden(readHidden()), { defer: true }));
  function hideRoomView(hide: boolean) {
    setRoomViewHidden(hide);
    try {
      localStorage.setItem(hiddenKey(), hide ? "1" : "0");
    } catch {
      /* private mode */
    }
  }
  // A phone call is only the people. The room itself is the Room button, so the
  // in-call room camera stays out of these layouts. A desktop window, even a
  // narrow one, is unchanged.
  const [box, setBox] = createSignal({ w: 0, h: 0 });
  const coarsePhone = () =>
    COARSE_POINTER && Math.min(window.innerWidth, window.innerHeight) < PHONE_SHORT;
  const phoneNow = () => {
    const { w, h } = box();
    if (w > 0 && h > 0) return COARSE_POINTER && Math.min(w, h) < PHONE_SHORT;
    return coarsePhone();
  };
  const showingRoomView = () =>
    Boolean(roomCamTrack()) && !roomViewHidden() && !props.noRoomViewTile && !phoneNow();
  let roomCamWatcher: Room | undefined;
  // Webcams of the people standing in the 3D room (their name -> video).
  const [roomFaces, setRoomFaces] = createSignal(new Map<string, RemoteTrack>());
  function setRoomFace(name: string, track: RemoteTrack | undefined) {
    setRoomFaces((prev) => {
      const next = new Map(prev);
      if (track) next.set(name, track);
      else next.delete(name);
      return next;
    });
  }
  // A room name is a member username: show their profile name.
  const roomFaceName = (name: string) => {
    for (const p of props.profiles.values()) if (roomName(p.username || "") === name) return displayName(p);
    return name;
  };
  const roomFaceColor = (name: string) => {
    for (const p of props.profiles.values()) if (roomName(p.username || "") === name) return p.color;
    return "#404040";
  };
  // Someone in the call AND in the room is one person: one tile, showing the
  // webcam from the room when their call camera is off. Room names may carry
  // "-ghost"; call identities are uids.
  const baseName = (name: string) => name.replace(/-ghost$/, "");
  const usernameOf = (identity: string) => roomName(props.profiles.get(identity)?.username || "");
  const callNames = () => {
    version();
    const names = new Set<string>();
    const current = room();
    if (!current) return names;
    for (const p of [current.localParticipant, ...current.remoteParticipants.values()]) {
      const name = usernameOf(p.identity);
      if (name) names.add(name);
    }
    return names;
  };
  const roomFaceOf = (identity: string) => {
    const name = usernameOf(identity);
    if (!name) return undefined;
    for (const [face, track] of roomFaces()) if (baseName(face) === name) return track;
    return undefined;
  };
  // people in the room who are not in the call: their own tiles
  const loneRoomFaces = () => [...roomFaces().entries()].filter(([face]) => !callNames().has(baseName(face)));
  const [joining, setJoining] = createSignal(false);
  const [error, setError] = createSignal("");
  const [version, setVersion] = createSignal(0);
  const [speaking, setSpeaking] = createSignal(new Set<string>());
  const bump = () => setVersion((v) => v + 1);
  const audioHost = document.createElement("div");
  audioHost.hidden = true;
  document.body.appendChild(audioHost);

  createEffect(() => props.onRoom?.(room()));
  createEffect(() => {
    const current = room();
    if (current && !props.viewOnly) onCleanup(bindCallControls(current));
  });
  createEffect(() => {
    const muted = deafened();
    audioHost.querySelectorAll<HTMLMediaElement>("audio,video").forEach(element => { element.muted = muted; });
  });


  // In a call: the Online list says so ("Videochat · <channel>").
  createEffect(() => {
    if (!room()) return;
    setInCall(props.channel.name);
    onCleanup(() => setInCall(undefined));
  });

  // Bumped on every hang-up: a join still connecting when you hang up (or
  // switch away) sees it changed and drops its connection instead of keeping it.
  let joinGen = 0;
  let joinTries = 0;
  function leave() {
    joinGen++;
    const current = room();
    setRoom(undefined);
    current?.disconnect();
    audioHost.replaceChildren();
    setSpeaking(new Set<string>());
    const watcher = roomCamWatcher;
    roomCamWatcher = undefined;
    watcher?.disconnect();
    setRoomCamTrack(undefined);
    secondScreen?.track?.stop();
    secondScreen = undefined;
    setSecondOn(false);
    streamCamGen++;
    const streamCam = streamCamPub;
    streamCamPub = undefined;
    streamCam?.track?.stop();
    setStreamCamOn(false);
    setStreamCamBusy(false);
    setStreamMenu(false);
    for (const pub of streamPubs) pub.track?.stop();
    streamPubs = [];
    setStreamOn(false);
    setStreamingIn(undefined);
    setRoomFaces(new Map<string, RemoteTrack>());
    seatControl?.stop();
    seatControl = undefined;
  }

  // Leaving the channel (or switching away) hangs up.
  createEffect(on(() => [props.serverId, props.channel.id], () => leave(), { defer: true }));
  onCleanup(() => {
    leave();
    audioHost.remove();
  });

  // The Room view watcher for this call; reconnects while the call lasts.
  function startRoomView(call: Room) {
    const source = props.roomView;
    if (!source || room() !== call) return;
    const retry = () => window.setTimeout(() => startRoomView(call), 3000);
    watchRoomCam(
      source,
      setRoomCamTrack,
      () => {
        if (room() === call) retry();
      },
      setRoomFace,
    )
      .then((watcher) => {
        if (room() !== call) {
          void watcher?.disconnect();
          return;
        }
        if (!watcher) {
          retry();
          return;
        }
        roomCamWatcher = watcher;
      })
      .catch(() => {
        if (room() === call) retry();
      });
  }

  async function join() {
    if (joining() || room()) return;
    setError("");
    setJoining(true);
    const gen = joinGen;
    try {
      const pass = await fetchPass(props.serverId, props.channel.id, Boolean(props.viewOnly));
      // LiveKit pauses a video it cannot see attached on the page, and the
      // picture goes black. The wall (viewOnly) is a page turned in 3D space.
      // The operation room hides these tiles and plays the same tracks in the
      // webcam row, which LiveKit does not know about. Both keep every video.
      // H.264 for everything we send: Chrome hands it to the graphics card's own
      // video encoder (NVENC), so a game holding the GPU's 3D engine near 100%
      // no longer starves the webcam and the stream (Kaalob's slow webcam).
      const phoneCap = phoneCameraCapture();
      const next = new Room({
        adaptiveStream: !props.viewOnly && !props.webcamOnly,
        dynacast: true,
        publishDefaults: { videoCodec: "h264" },
        // Without this, LiveKit fills a missing size with exact 1280×720 (16:9).
        ...(phoneCap ? { videoCaptureDefaults: phoneCap } : {}),
      });
      next
        .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
          if (track.kind === Track.Kind.Audio) {
            const element = track.attach(); element.muted = deafened(); audioHost.appendChild(element);
          }
          bump();
        })
        .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
          track.detach().forEach((el) => el.remove());
          bump();
        })
        .on(RoomEvent.ActiveSpeakersChanged, (who: Participant[]) => setSpeaking(new Set(who.map((p) => p.identity))))
        .on(RoomEvent.DataReceived, (_payload, participant, _kind, topic) => {
          if (topic === ATTENTION_TOPIC && participant) flashTile(participant.identity);
        })
        .on(RoomEvent.Disconnected, () => {
          if (room() === next) leave();
        });
      for (const event of [
        RoomEvent.ParticipantConnected,
        RoomEvent.ParticipantDisconnected,
        RoomEvent.TrackMuted,
        RoomEvent.TrackUnmuted,
        RoomEvent.LocalTrackPublished,
        RoomEvent.LocalTrackUnpublished,
        RoomEvent.TrackPublished,
        RoomEvent.TrackUnpublished,
        RoomEvent.ParticipantAttributesChanged,
      ]) {
        next.on(event, bump);
      }
      await next.connect(pass.url, pass.token);
      if (gen !== joinGen) {
        // hung up (or switched away) while this was connecting
        await next.disconnect();
        return;
      }
      setRoom(next);
      joinTries = 0;
      bump();
      if (phoneNow()) {
        void next.localParticipant.setAttributes({ dh_phone: "1" }).catch(() => {});
      }
      if (props.seats) seatControl = startSeats(next);
      // In the call: also watch the 3D room's camera (the Room view).
      if (props.roomView) startRoomView(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join the call.");
      if (gen === joinGen && joinTries < 6) {
        joinTries += 1;
        window.setTimeout(() => void join(), 5000);
      }
    } finally {
      setJoining(false);
    }
  }

  if (props.autoJoin) queueMicrotask(() => void join());

  // The Darkwood Room (this tile's Room side) asks this call to sit, stand,
  // and turn the camera or the share on or off.
  let seatControl: SeatControl | undefined;
  createEffect(() => {
    if (!props.seats) return;
    const fromRoom = (e: MessageEvent) => {
      if (e.origin !== location.origin || !room()) return;
      const frames = document.querySelectorAll<HTMLIFrameElement>(".room-layer iframe");
      if (![...frames].some((f) => f.contentWindow === e.source)) return;
      const type = (e.data as { type?: string } | null)?.type;
      if (type === "dh-seat-sit") seatControl?.sit(Number((e.data as { seat?: unknown }).seat));
      if (type === "dh-seat-stand") seatControl?.stand();
      if (type === "dh-camera") void toggleCam();
      if (type === "dh-share") void toggle("screen");
    };
    window.addEventListener("message", fromRoom);
    onCleanup(() => window.removeEventListener("message", fromRoom));
  });

  const local = () => {
    version();
    return room()?.localParticipant;
  };
  const micOn = () => Boolean(local()?.isMicrophoneEnabled);
  const camOn = () => Boolean(local()?.isCameraEnabled);
  const screenOn = () => Boolean(local()?.isScreenShareEnabled);
  let secondScreen: LocalTrackPublication | undefined;
  const [secondOn, setSecondOn] = createSignal(false);
  const sharedCount = () => (screenOn() ? 1 : 0) + (secondOn() ? 1 : 0);
  const [shareMenu, setShareMenu] = createSignal(false);
  // a click anywhere else closes the share menu
  createEffect(() => {
    if (!shareMenu()) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.(".share-wrap")) setShareMenu(false);
    };
    window.addEventListener("pointerdown", close);
    onCleanup(() => window.removeEventListener("pointerdown", close));
  });

  /** Share (or stop) a 2nd screen, next to the first. */
  async function toggleSecondScreen() {
    const me = room()?.localParticipant;
    if (!me) return;
    setError("");
    if (secondScreen) {
      await stopSecondScreen();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const media = stream.getVideoTracks()[0];
      if (!media) return;
      // the browser's own "Stop sharing" ends it too
      media.addEventListener("ended", () => void stopSecondScreen());
      secondScreen = await me.publishTrack(media, { name: SECOND_SCREEN, source: Track.Source.Unknown, simulcast: false });
      setSecondOn(true);
    } catch (err) {
      // picking nothing in the browser's dialog is not an error
      if (!(err instanceof DOMException && err.name === "NotAllowedError")) {
        setError(err instanceof Error ? err.message : "That screen could not be shared.");
      }
    }
    bump();
  }
  // ---- stream mode --------------------------------------------------------
  let streamPubs: LocalTrackPublication[] = [];
  const [streamOn, setStreamOn] = createSignal(false);
  const [streamBusy, setStreamBusy] = createSignal(false);
  async function toggleStream() {
    if (props.webcamOnly) return;
    const me = room()?.localParticipant;
    if (!me || streamBusy()) return;
    setError("");
    if (streamPubs.length) {
      await stopStream();
      return;
    }
    setStreamBusy(true);
    try {
      // a game or a window, smooth, with its sound if "share audio" is ticked
      const media = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 }, width: { ideal: STREAM_SIZE.width }, height: { ideal: STREAM_SIZE.height } },
        audio: true,
      });
      const video = media.getVideoTracks()[0];
      if (!video) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      video.contentHint = "motion";
      video.addEventListener("ended", () => void stopStream());
      streamPubs = [
        await me.publishTrack(video, {
          name: STREAM,
          source: Track.Source.Unknown,
          // the small LIVE tile previews and small tiles take the small copy
          simulcast: true,
          // low priority: when the upload is tight, the stream gives way to the webcam
          videoEncoding: { maxBitrate: STREAM_SIZE.maxBitrate, maxFramerate: 30, priority: "low" },
          videoSimulcastLayers: [...STREAM_SIZE.layers],
          degradationPreference: "balanced",
        }),
      ];
      const audio = media.getAudioTracks()[0];
      if (audio) streamPubs.push(await me.publishTrack(audio, { name: STREAM_AUDIO, source: Track.Source.ScreenShareAudio }));
      setStreamOn(true);
      setTeam(undefined);
      setStreamingIn({ serverId: props.serverId, channelId: props.channel.id });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "NotAllowedError")) {
        setError(err instanceof Error ? err.message : "That could not be streamed.");
      }
    } finally {
      setStreamBusy(false);
    }
    bump();
  }
  // ---- attention: a white strobe around someone's tile ---------------------
  const [flashing, setFlashing] = createSignal(new Set<string>());
  const flashTimers = new Map<string, number>();
  function flashTile(identity: string) {
    window.clearTimeout(flashTimers.get(identity));
    setFlashing((prev) => new Set(prev).add(identity));
    flashTimers.set(
      identity,
      window.setTimeout(() => {
        flashTimers.delete(identity);
        setFlashing((prev) => {
          const next = new Set(prev);
          next.delete(identity);
          return next;
        });
      }, ATTENTION_MS),
    );
  }
  onCleanup(() => flashTimers.forEach((t) => window.clearTimeout(t)));
  /**
   * Ask for attention: your tile strobes on everyone's screen, or (to) only on
   * that one person's screen. Yours flashes too, so you know it went out.
   */
  const [attentionMenu, setAttentionMenu] = createSignal(false);
  createEffect(() => {
    if (!attentionMenu()) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.(".attention-wrap")) setAttentionMenu(false);
    };
    window.addEventListener("pointerdown", close);
    onCleanup(() => window.removeEventListener("pointerdown", close));
  });
  // the people you can call: everyone else in the call (not the hidden watchers)
  const others = () => {
    void version();
    return [...(room()?.remoteParticipants.values() ?? [])];
  };
  async function callAttention(to?: string) {
    setAttentionMenu(false);
    const me = room()?.localParticipant;
    if (!me) return;
    flashTile(me.identity);
    try {
      await me.publishData(new TextEncoder().encode("1"), {
        reliable: true,
        topic: ATTENTION_TOPIC,
        ...(to ? { destinationIdentities: [to] } : {}),
      });
    } catch {
      setError("Could not send that. Check your connection.");
    }
  }

  // ---- remove someone from the call (the server's owner and admins) -----------
  const [removeMenu, setRemoveMenu] = createSignal(false);
  const [removeAsk, setRemoveAsk] = createSignal<{ uid: string; name: string } | undefined>();
  const [removing, setRemoving] = createSignal(false);
  createEffect(() => {
    if (!removeMenu()) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.(".remove-wrap")) setRemoveMenu(false);
    };
    window.addEventListener("pointerdown", close);
    onCleanup(() => window.removeEventListener("pointerdown", close));
  });
  async function confirmRemove() {
    const who = removeAsk();
    if (!who || removing()) return;
    setRemoving(true);
    try {
      await removeFromCall(props.serverId, props.channel.id, who.uid);
      audit("call.remove", { serverId: props.serverId, target: who.name, detail: props.channel.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove them.");
    } finally {
      setRemoving(false);
      setRemoveAsk(undefined);
    }
  }

  // ---- team up: two (or more) streams of the same game share one LIVE tile ---
  const [team, setTeam] = createSignal<string | undefined>();
  const [teamOffer, setTeamOffer] = createSignal(false);
  const [teamWait, setTeamWait] = createSignal<string | undefined>();
  const [teamAsk, setTeamAsk] = createSignal<string | undefined>();
  /** Team up with another streamer here (their uid), or undefined to leave the team. */
  function teamUp(uid: string | undefined) {
    setTeam(uid);
    if (streamOn() || streamCamOn()) setStreamingIn({ serverId: props.serverId, channelId: props.channel.id, ...(uid ? { team: uid } : {}) });
  }
  const streamingNow = () => streamOn() || streamCamOn();
  // the other people streaming in this videochat: who you can team up with
  const otherStreamers = () => [...(room()?.remoteParticipants.values() ?? [])].filter((p) => streamOf(p) || streamCamOf(p));
  async function sendTeam(to: string, type: "ask" | "yes" | "no" | "cancel" | "leave") {
    const me = room()?.localParticipant;
    if (!me) return;
    await me.publishData(new TextEncoder().encode(JSON.stringify({ type })), {
      reliable: true,
      topic: TEAM_TOPIC,
      destinationIdentities: [to],
    });
  }
  function leaveTeam() {
    const mate = team();
    setTeamOffer(false);
    setTeamWait(undefined);
    if (mate) void sendTeam(mate, "leave");
    teamUp(undefined);
  }
  async function askTeam(uid: string) {
    setTeamOffer(false);
    setTeamWait(uid);
    try {
      await sendTeam(uid, "ask");
    } catch {
      setTeamWait(undefined);
      setError("Could not send that. Check your connection.");
    }
  }
  function cancelAsk() {
    const uid = teamWait();
    setTeamWait(undefined);
    if (uid) void sendTeam(uid, "cancel");
  }
  async function answerTeam(yes: boolean) {
    const uid = teamAsk();
    setTeamAsk(undefined);
    if (!uid) return;
    try {
      await sendTeam(uid, yes ? "yes" : "no");
    } catch {
      setError("Could not send that. Check your connection.");
      return;
    }
    if (yes) teamUp(uid);
  }

  async function stopStream() {
    const pubs = streamPubs;
    streamPubs = [];
    setStreamOn(false);
    setStreamingIn(undefined);
    for (const pub of pubs) {
      if (pub.track) await room()?.localParticipant.unpublishTrack(pub.track).catch(() => {});
      pub.track?.stop();
    }
    bump();
  }
  // Someone's stream, if they are streaming.
  const streamOf = (participant: Participant) => {
    void version();
    for (const pub of participant.trackPublications.values()) {
      if (pub.trackName === STREAM && pub.kind === Track.Kind.Video && !pub.isMuted && pub.track) return pub.track;
    }
    return undefined;
  };
  /** Stream's webcam, shown on the primary webcam tile. This is not a screen share. */
  const streamCamOf = (participant: Participant) => {
    void version();
    for (const pub of participant.trackPublications.values()) {
      if (pub.trackName === STREAM_CAM && pub.kind === Track.Kind.Video && !pub.isMuted && pub.track) return pub.track;
    }
    return undefined;
  };
  // Wall Street's big panel: whoever's Stream (screen or webcam) is on right
  // now - a real webcam, or an OBS virtual camera through Stream's picker,
  // same as everywhere else Stream already works. Nobody streaming: empty.
  const broadcastTrack = createMemo(() => {
    if (!isBroadcastRoom(props.channel.roomKey)) return undefined;
    void version();
    const current = room();
    if (!current) return undefined;
    for (const p of [current.localParticipant, ...current.remoteParticipants.values()]) {
      const t = streamOf(p) ?? streamCamOf(p);
      if (t) return t;
    }
    return undefined;
  });
  // Wall Street's big panel has two tabs: a live TradingView chart (your own
  // session in your own browser - everyone gets their own, fully
  // interactive, not shared) or whoever's Stream is on (so everyone can
  // watch one specific person's own TradingView tab, drawings and all).
  // Living Room shares the same big panel, but has no Chart tab at all -
  // its screen is always whoever's Stream (webcam or OBS) is on.
  const showChartTab = () => props.channel.roomKey === WALL_STREET_ROOMKEY;
  const [bigView, setBigView] = createSignal<"chart" | "stream">("chart");
  const effectiveBigView = () => (showChartTab() ? bigView() : "stream");
  // The charts' timeframe, remembered across visits (TIMEFRAME_PICKER below).
  const [chartInterval, setChartInterval] = createSignal(recallInterval());
  function pickInterval(value: string) {
    setChartInterval(value);
    try {
      localStorage.setItem(WALL_STREET_INTERVAL_KEY, value);
    } catch {
      /* private mode */
    }
  }
  // Whose tile shows the stream big and the webcam small: your own choice,
  // only on your screen (double-click the small picture).
  const [swapped, setSwapped] = createSignal(new Set<string>());
  const swap = (identity: string) =>
    setSwapped((prev) => {
      const next = new Set(prev);
      if (next.has(identity)) next.delete(identity);
      else next.add(identity);
      return next;
    });

  // Which corner of a tile the small picture sits in: dragged there, only on
  // your screen (top left to start, like the drawing).
  const [corners, setCorners] = createSignal(new Map<string, InsetCorner>());
  const setCorner = (identity: string, corner: InsetCorner) =>
    setCorners((prev) => new Map(prev).set(identity, corner));
  // and how big it is (dragging its inner corner), also only on your screen
  const [insetSizes, setInsetSizes] = createSignal(new Map<string, number>());
  const setInsetSize = (identity: string, size: number) =>
    setInsetSizes((prev) => new Map(prev).set(identity, size));

  async function stopSecondScreen() {
    const pub = secondScreen;
    secondScreen = undefined;
    setSecondOn(false);
    if (pub?.track) await room()?.localParticipant.unpublishTrack(pub.track).catch(() => {});
    pub?.track?.stop();
    bump();
  }

  /**
   * Camera off is off everywhere (Kaalob): the 3D room open in this app (a
   * tile's Room side) turns its webcam off too, or your face would still
   * show on your avatar and through the room's webcams.
   */
  function cameraOffInRooms() {
    for (const frame of document.querySelectorAll<HTMLIFrameElement>(".room-layer iframe")) {
      try {
        frame.contentWindow?.postMessage({ type: "dh-camera-off" }, new URL(frame.src).origin);
      } catch {
        /* a room that is not loaded yet has no webcam on */
      }
    }
  }

  // The Camera button answers at once: it shows what you asked for while the
  // camera starts or stops, and quick extra clicks only change the wish. One
  // loop catches the camera up to your last click, each step with a way out;
  // the wish belongs to the call it was made in, so leaving or reconnecting
  // drops it instead of letting a slow start write over the next call.
  // This is the primary webcam: the browser's default camera, no device picker.
  const [camWant, setCamWant] = createSignal<boolean | undefined>();
  const camShown = () => camWant() ?? camOn();
  let camRun = 0; // one per call: an old loop sees the change and stops
  let camLooping = false;

  createEffect(() => {
    room();
    camRun++;
    camLooping = false;
    setCamWant(undefined);
  });

  /** One camera start or stop, and a way out if the browser never answers. */
  async function moveCamera(active: LocalParticipant, on: boolean) {
    let timer = 0;
    const attempt = (async () => {
      const capture = on ? phoneCameraCapture() : undefined;
      try {
        await active.setCameraEnabled(on, capture, CAMERA_PUBLISH);
      } catch (err) {
        // A phone that rejects the full-frame request still has to open.
        // A permission refusal is not that: asking again would prompt twice.
        const name = err instanceof Error ? err.name : "";
        if (!capture || name === "NotAllowedError" || name === "SecurityError") throw err;
        // Still 9:16, without the exact ratio that this phone rejected.
        // A bare retry would open LiveKit's exact 1280×720, which is 16:9.
        await active.setCameraEnabled(true, phoneCameraCapture(true), CAMERA_PUBLISH);
      }
    })()
      .then(
        () => ({ ok: true as const }),
        (err: unknown) => ({
          ok: false as const,
          message: err instanceof Error ? err.message : on ? "The camera could not be turned on." : "The camera could not be turned off.",
        }),
      )
      .finally(bump);
    const slow = new Promise<{ ok: false; message: string }>((resolve) => {
      timer = window.setTimeout(
        () => resolve({ ok: false, message: "The camera did not answer. Check the browser's camera permission, then try again." }),
        CAMERA_TIMEOUT_MS,
      );
    });
    const result = await Promise.race([attempt, slow]);
    window.clearTimeout(timer);
    if (result.ok && on) await widenPhoneCamera(active);
    return result;
  }

  // Turning the phone changes which shape its camera should be. Ask again
  // for whichever one that now is - widenPhoneCamera reads it fresh.
  if (COARSE_POINTER && typeof screen !== "undefined" && screen.orientation) {
    const onTurn = () => {
      const me = room()?.localParticipant;
      if (me?.isCameraEnabled) void widenPhoneCamera(me);
    };
    screen.orientation.addEventListener("change", onTurn);
    onCleanup(() => screen.orientation.removeEventListener("change", onTurn));
  }

  async function toggleCam() {
    const me = room()?.localParticipant;
    if (!me) return;
    setError("");
    const next = !camShown();
    setCamWant(next);
    if (!next) cameraOffInRooms();
    if (camLooping) return;
    camLooping = true;
    const run = camRun;
    try {
      let tried: boolean | undefined;
      for (;;) {
        const want = camWant();
        const active = room()?.localParticipant;
        if (run !== camRun || want === undefined || !active) break;
        if (active.isCameraEnabled === want) break;
        if (tried === want) break; // it did not take; do not spin
        tried = want;
        const result = await moveCamera(active, want);
        if (run !== camRun) return;
        if (!result.ok) {
          setError(result.message);
          break;
        }
        bump();
      }
    } finally {
      if (run === camRun) {
        camLooping = false;
        setCamWant(undefined);
        bump();
      }
    }
  }

  // Stream: one other webcam, shown as its own screen. It never takes the primary camera.
  let streamCamPub: LocalTrackPublication | undefined;
  let streamCamGen = 0;
  let streamCamDevice = savedStreamCam();
  let listedDevices: MediaDeviceInfo[] = [];
  const [streamCamOn, setStreamCamOn] = createSignal(false);
  const [streamCamBusy, setStreamCamBusy] = createSignal(false);
  const [streamMenu, setStreamMenu] = createSignal(false);
  const [camList, setCamList] = createSignal<CamChoice[]>([]);
  const [camListBusy, setCamListBusy] = createSignal(false);
  const streamLiveId = () => streamCamPub?.track?.mediaStreamTrack.getSettings().deviceId ?? "";
  const usingStream = (cam: CamChoice) => {
    if (!streamCamOn()) return false;
    if (streamLiveId() === cam.id) return true;
    const label = bareCameraLabel(streamCamPub?.track?.mediaStreamTrack.label ?? "");
    return label !== "" && label === bareCameraLabel(cam.label);
  };
  const primaryLive = () => {
    const track = room()?.localParticipant.getTrackPublication(Track.Source.Camera)?.track?.mediaStreamTrack;
    return { id: track?.getSettings().deviceId ?? "", label: bareCameraLabel(track?.label ?? "") };
  };
  /** The browser default camera, and the camera the Camera button already has open. */
  function isPrimaryDevice(id: string, label = "") {
    if (id === "default" || id === "communications") return true;
    const primaryId = primaryCameraId(listedDevices);
    if (primaryId && id === primaryId) return true;
    const live = primaryLive();
    if (live.id && live.id !== "default" && live.id !== "communications" && id === live.id) return true;
    const bare = bareCameraLabel(label);
    if (live.label && bare && live.label === bare) return true;
    const fallback = listedDevices.find((d) => d.kind === "videoinput" && d.deviceId === "default");
    const fallbackBare = bareCameraLabel(fallback?.label ?? "");
    return Boolean(fallbackBare && bare && fallbackBare === bare);
  }

  // A click anywhere else closes the Stream list.
  createEffect(() => {
    if (!streamMenu()) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.(".cam-wrap")) setStreamMenu(false);
    };
    const refresh = () => void loadCameras();
    window.addEventListener("pointerdown", close);
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    onCleanup(() => {
      window.removeEventListener("pointerdown", close);
      navigator.mediaDevices?.removeEventListener("devicechange", refresh);
    });
  });

  /** Webcams other than the primary one. Names stay hidden until the browser allows a camera. */
  async function loadCameras() {
    setCamListBusy(true);
    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      const named = devices.some((d) => d.kind === "videoinput" && d.deviceId && d.label);
      if (!named && !streamCamOn() && !camOn()) {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        probe.getTracks().forEach((track) => track.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
      }
      listedDevices = devices;
      let list = listedCameras(devices).filter((cam) => !isPrimaryDevice(cam.id, cam.label));
      const live = streamCamPub?.track?.mediaStreamTrack;
      const liveId = live?.getSettings().deviceId ?? "";
      const liveLabel = bareCameraLabel(live?.label ?? "");
      if (liveId && liveLabel) list = list.map((cam) => (cam.id === liveId ? { ...cam, label: liveLabel } : cam));
      setCamList(list);
      if (list.length === 0) setError(listedCameras(devices).length === 0 ? "No webcam found." : "No other webcam found.");
    } catch (err) {
      setStreamMenu(false);
      if (err instanceof DOMException && err.name === "NotAllowedError") setError("The browser blocked the webcam.");
      else setError(err instanceof Error ? err.message : "The webcams could not be listed.");
    } finally {
      setCamListBusy(false);
    }
  }

  function openStreamMenu() {
    if (streamMenu()) {
      setStreamMenu(false);
      return;
    }
    setError("");
    setStreamMenu(true);
    void loadCameras();
  }

  async function stopStreamCam() {
    streamCamGen++;
    const pub = streamCamPub;
    streamCamPub = undefined;
    setStreamCamOn(false);
    const mate = team();
    setTeam(undefined);
    setTeamOffer(false);
    setTeamWait(undefined);
    setTeamAsk(undefined);
    if (mate) void sendTeam(mate, "leave");
    if (pub?.track) await room()?.localParticipant.unpublishTrack(pub.track).catch(() => {});
    pub?.track?.stop();
    if (!streamOn()) setStreamingIn(undefined);
    bump();
  }

  async function startStreamCam() {
    if (props.webcamOnly) return;
    const me = room()?.localParticipant;
    const id = streamCamDevice;
    if (!me || !id) {
      setError("Choose a webcam for Stream.");
      return;
    }
    if (isPrimaryDevice(id)) {
      setError("That webcam is the primary camera.");
      return;
    }
    const token = ++streamCamGen;
    setStreamCamBusy(true);
    setError("");
    let media: MediaStreamTrack | undefined;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: id },
          frameRate: { ideal: 30 },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      media = stream.getVideoTracks()[0];
      if (token !== streamCamGen || !media) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const settingsId = media.getSettings().deviceId ?? "";
      if (isPrimaryDevice(id, media.label) || (settingsId && isPrimaryDevice(settingsId, media.label))) {
        stream.getTracks().forEach((track) => track.stop());
        if (token === streamCamGen) setError("That webcam is the primary camera.");
        return;
      }
      media.contentHint = "motion";
      media.addEventListener("ended", () => {
        if (streamCamPub?.track?.mediaStreamTrack === media) void stopStreamCam();
      });
      const published = await me.publishTrack(media, STREAM_CAM_PUBLISH);
      if (token !== streamCamGen) {
        await me.unpublishTrack(published.track ?? media).catch(() => {});
        media.stop();
        return;
      }
      streamCamPub = published;
      setStreamCamOn(true);
      setStreamingIn({ serverId: props.serverId, channelId: props.channel.id });
      if (otherStreamers().length > 0) setTeamOffer(true);
    } catch (err) {
      media?.stop();
      if (token === streamCamGen) {
        if (err instanceof DOMException && err.name === "NotAllowedError") setError("The browser blocked the webcam.");
        else if (err instanceof DOMException && (err.name === "NotFoundError" || err.name === "OverconstrainedError")) {
          setError("That webcam could not be turned on.");
        } else setError(err instanceof Error ? err.message : "That webcam could not be turned on.");
      }
    } finally {
      if (token === streamCamGen) setStreamCamBusy(false);
    }
    bump();
  }

  /** Use this webcam as Stream. Picking the one already there turns Stream off. */
  async function chooseStreamCam(id: string) {
    setStreamMenu(false);
    const picked = camList().find((cam) => cam.id === id);
    if (isPrimaryDevice(id, picked?.label ?? "")) {
      setError("That webcam is the primary camera.");
      return;
    }
    streamCamDevice = id;
    rememberStreamCam(id);
    if (streamCamOn() && picked && usingStream(picked)) {
      await stopStreamCam();
      return;
    }
    if (streamCamOn()) await stopStreamCam();
    await startStreamCam();
  }

  async function toggle(kind: "mic" | "cam" | "screen") {
    if (kind === "cam") return toggleCam();
    const me = room()?.localParticipant;
    if (!me) return;
    setError("");
    try {
      if (kind === "mic") await toggleMicrophone();
      if (kind === "screen" && !noShare()) await me.setScreenShareEnabled(!me.isScreenShareEnabled, { audio: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "That device could not be turned on.");
    }
    bump();
  }

  // One tile per person, plus one per screen being shared (shown first).
  const tiles = createMemo<TileInfo[]>(() => {
    version();
    const current = room();
    if (!current) return [];
    const remote = [...current.remoteParticipants.values()];
    const people: Participant[] = props.viewOnly ? remote : [current.localParticipant, ...remote];
    const screens: TileInfo[] = [];
    const cams: TileInfo[] = [];
    for (const p of people) {
      for (const pub of p.trackPublications.values()) {
        if (pub.trackName === STREAM || pub.trackName === STREAM_AUDIO || pub.trackName === STREAM_CAM) continue;
        const second = pub.trackName === SECOND_SCREEN;
        if (pub.kind !== Track.Kind.Video || pub.isMuted || (pub.source !== Track.Source.ScreenShare && !second)) continue;
        screens.push({ key: `${p.identity}:${pub.trackSid}`, participant: p, publication: pub, screen: true, second });
      }
      cams.push({ key: `${p.identity}:cam`, participant: p, publication: p.getTrackPublication(Track.Source.Camera), screen: false });
    }
    return [...screens, ...cams];
  });

  // the name on a tile: their chosen videochat name, else their name
  const nameOf = (p: Participant) => {
    const profile = props.profiles.get(p.identity);
    return displayName(profile, p.name || "Member");
  };
  const personName = (uid: string) => {
    const here = room();
    const person = uid === here?.localParticipant.identity ? here.localParticipant : here?.remoteParticipants.get(uid);
    return person ? nameOf(person) : displayName(props.profiles.get(uid), "Member");
  };
  createEffect(() => {
    const current = room();
    if (!current) return;
    const onTeam = (payload: Uint8Array, participant?: Participant, _kind?: unknown, topic?: string) => {
      if (topic !== TEAM_TOPIC || !participant) return;
      let type = "";
      try {
        type = (JSON.parse(new TextDecoder().decode(payload)) as { type?: string }).type ?? "";
      } catch {
        return;
      }
      const from = participant.identity;
      if (type === "ask") {
        if (!streamingNow() || teamAsk() || teamWait() || team()) {
          void sendTeam(from, "no");
          return;
        }
        setTeamOffer(false);
        setTeamAsk(from);
        return;
      }
      if (type === "yes" && teamWait() === from) {
        setTeamWait(undefined);
        teamUp(from);
        return;
      }
      if ((type === "no" || type === "cancel") && (teamWait() === from || teamAsk() === from)) {
        setTeamWait(undefined);
        if (teamAsk() === from) setTeamAsk(undefined);
        return;
      }
      if (type === "leave" && team() === from) teamUp(undefined);
    };
    current.on(RoomEvent.DataReceived, onTeam);
    onCleanup(() => current.off(RoomEvent.DataReceived, onTeam));
  });
  // The side-bar TV, opened big, shows this same row of webcams underneath.
  // A watch-only wall must not replace the call you are actually in.
  createEffect(() => {
    if (props.viewOnly) return;
    // Not in the call yet: leave the row to the watch-only strip.
    if (!room()) {
      setCallFaces(undefined);
      return;
    }
    const callers = tiles()
      .filter((t) => !t.screen)
      .map((t) => {
        const pub = t.publication;
        const on = Boolean(pub?.track) && !pub!.isMuted && pub!.isSubscribed;
        return {
          identity: t.participant.identity,
          name: nameOf(t.participant),
          video: on ? pub!.track!.mediaStream : undefined,
        };
      });
    setCallFaces({ channelKey: `${props.serverId}/${props.channel.id}`, callers });
  });
  onCleanup(() => {
    if (!props.viewOnly) setCallFaces(undefined);
  });

  // ---- the layout (Kaalob's drawings) --------------------------------------
  // Desktop, when somebody is on a phone: rows of mixed tiles. A desktop
  // camera stays 16:9. A phone camera is the vertical tile of that same
  // height, and a shorter row is centred. With nobody on a phone, the old
  // equal 16:9 grid stays, Room view included:
  //   1 person   [you][Room view]
  //   2 people   the two stacked on the left, the Room view on the right, centred
  //   3 people   a 2x2 grid, the Room view in the last spot
  //   4 or more  everyone in the grid, the Room view small at the top right
  // Phone (pointer is coarse and the short side is under 540px): the room view
  // stays hidden. You alone fill the phone. With other people, two wide
  // cameras stack full width. Everyone else sits in a small row at the bottom.
  // Your camera is the small vertical tile. Swipe right opens the channel
  // list. Swipe left opens the channel chat. When someone is sharing, that
  // same left swipe opens the screen shares instead. Tap a share to open it
  // beside the person sharing it. Swipe back to the call.
  let tilesEl: HTMLDivElement | undefined;
  let boxObserver: ResizeObserver | undefined;
  function watchBox(el: HTMLDivElement) {
    tilesEl = el;
    boxObserver?.disconnect();
    boxObserver = new ResizeObserver(([entry]) => setBox({ w: entry.contentRect.width, h: entry.contentRect.height }));
    boxObserver.observe(el);
  }
  let shareAlive = true;
  onCleanup(() => {
    shareAlive = false;
    boxObserver?.disconnect();
  });

  // A team (streamers who teamed up, Kaalob): one extra screen in the grid,
  // showing each member's stream for 10 s in turn. Only members here now.
  // Kept as plain text ("uid1,uid2") and only changed when a team really
  // changes: a rebuilt list would restart each screen's 10 s turn on every
  // call event.
  const teamScreens = createMemo(
    () => {
      void version();
      const here = room();
      if (!here) return [];
      const inCall = new Set([here.localParticipant.identity, ...here.remoteParticipants.keys()]);
      return (props.teams ?? [])
        .map((t) => t.filter((uid) => inCall.has(uid)))
        .filter((t) => t.length > 1)
        .map((t) => t.join(","));
    },
    [],
    { equals: (a, b) => a.length === b.length && a.every((k, i) => k === b[i]) },
  );
  const teamKey = (members: string) => `team:${members}`;
  // teamed-up players: their streams show only in the team screen, so their
  // own tiles show just the webcam (Kaalob)
  const inTeam = createMemo(() => new Set(teamScreens().flatMap((members) => members.split(","))));
  // a member's stream track (theirs, or your own)
  const streamFor = (uid: string) => {
    const here = room();
    if (!here) return undefined;
    const participant = uid === here.localParticipant.identity ? here.localParticipant : here.remoteParticipants.get(uid);
    return participant ? streamOf(participant) ?? streamCamOf(participant) : undefined;
  };
  const people = () => tiles().length + loneRoomFaces().length + teamScreens().length;
  const readPip = (): PipSpot => {
    try {
      const saved = localStorage.getItem("dh_phone_pip");
      if (saved === "top" || saved === "left" || saved === "right" || saved === "bottom") return saved;
    } catch {
      /* private mode */
    }
    return "top";
  };
  const [pipSpot, setPipSpot] = createSignal<PipSpot>(readPip());
  const [pipWide, setPipWide] = createSignal(window.innerWidth >= window.innerHeight);
  // Which cameras are taller than wide. Phone tiles use this: desktop stays
  // 16:9, a phone picture is the vertical tile beside it.
  const [frameWide, setFrameWide] = createSignal<Record<string, boolean>>({});
  function rememberFrame(key: string, wide: boolean) {
    setFrameWide((prev) => (prev[key] === wide ? prev : { ...prev, [key]: wide }));
  }
  const setPip = (spot: PipSpot) => {
    setPipSpot(spot);
    try {
      localStorage.setItem("dh_phone_pip", spot);
    } catch {
      /* private mode */
    }
  };
  // Phone share pager. The shelf and an entered share are the same page, to
  // the right of the people. A tap enters; a swipe never does.
  const [shareView, setShareView] = createSignal<ShareView>("people");
  const [openShare, setOpenShare] = createSignal<string | undefined>();
  const [shareDragX, setShareDragX] = createSignal(0);
  const [shareDragging, setShareDragging] = createSignal(false);
  const wallStreetBig = createMemo<JSX.CSSProperties | undefined>(() => {
    if (!isBroadcastRoom(props.channel.roomKey)) return undefined;
    const { w, h } = box();
    if (w <= 0 || h <= 0) return undefined;
    const keys = tiles()
      .filter((t) => !t.screen)
      .map((t) => t.key)
      .concat(loneRoomFaces().map(([name]) => `face:${name}`), teamScreens().map(teamKey));
    return broadcastPlan({
      keys,
      width: w,
      height: h,
      overlap: props.channel.roomKey === LIVING_ROOM_ROOMKEY ? 40 : 0,
      stripHeight: props.channel.roomKey === LIVING_ROOM_ROOMKEY ? 220 : undefined,
      rowWidthRatio: props.channel.roomKey === LIVING_ROOM_ROOMKEY ? 0.53 : undefined,
    }).big as JSX.CSSProperties;
  });
  const layout = createMemo(() => {
    const n = people();
    const rv = showingRoomView();
    let cols: number;
    let rows: number;
    let small = false;
    const { w: boxW, h: boxH } = box();
    const phone = phoneNow() && n > 0;
    if (phone) {
      const cams = tiles().filter((t) => !t.screen);
      const screens = tiles().filter((t) => t.screen);
      const local = cams.find((t) => t.participant.isLocal);
      const keys = [
        ...cams.filter((t) => t !== local).map((t) => t.key),
        ...loneRoomFaces().map(([name]) => `face:${name}`),
        ...teamScreens().map(teamKey),
        ...(local ? [local.key] : []),
      ];
      const landscape = (boxW || window.innerWidth) >= (boxH || window.innerHeight);
      const width = boxW || window.innerWidth;
      const height = boxH || window.innerHeight;
      const wide = frameWide();
      const plan = phonePlan({
        keys,
        localKey: local?.key,
        landscape,
        width,
        height,
        pipSpot: pipSpot(),
        pipWide: pipWide(),
        portraitKeys: cams
          .filter((t) => !t.participant.isLocal && (wide[t.key] === false || t.participant.attributes?.dh_phone === "1"))
          .map((t) => t.key),
      });
      const open = screens.find((t) => t.key === openShare());
      const entered = shareView() === "open" && open ? open : undefined;
      const sharePlaces = phoneSharePlaces({
        screenKeys: screens.map((t) => t.key),
        openKey: entered?.key,
        sharerKey: entered ? `${entered.participant.identity}:cam` : undefined,
        landscape,
        width,
        height,
      });
      return {
        n: keys.length,
        narrow: false,
        phone: true,
        scroll: plan.scroll,
        pipKey: plan.pipKey,
        places: { ...plan.places, ...sharePlaces } as Record<string, JSX.CSSProperties>,
        small: false,
        grid: plan.grid as JSX.CSSProperties,
        cols: 1,
        tileH: 0,
        smallSize: { width: "0px", height: "0px" },
      };
    }
    // Wall Street and Living Room: a permanent big panel (the Webcam/OBS
    // screen - whoever's Stream is on, below) plus a webcam-only row, on
    // its own layout entirely - never the narrow/grid/deskPlan branches
    // below, any size.
    if (isBroadcastRoom(props.channel.roomKey) && boxW > 0 && boxH > 0) {
      // webcams only here - a screen share has nowhere to go in this layout
      const cams = tiles().filter((t) => !t.screen);
      const keys = [
        ...cams.map((t) => t.key),
        ...loneRoomFaces().map(([name]) => `face:${name}`),
        ...teamScreens().map(teamKey),
      ];
      const { places } = broadcastPlan({
        keys,
        width: boxW,
        height: boxH,
        overlap: props.channel.roomKey === LIVING_ROOM_ROOMKEY ? 40 : 0,
        stripHeight: props.channel.roomKey === LIVING_ROOM_ROOMKEY ? 220 : undefined,
        rowWidthRatio: props.channel.roomKey === LIVING_ROOM_ROOMKEY ? 0.53 : undefined,
      });
      return {
        n: keys.length,
        narrow: false,
        phone: false,
        scroll: false,
        pipKey: undefined as string | undefined,
        places: places as Record<string, JSX.CSSProperties>,
        small: false,
        grid: {} as JSX.CSSProperties,
        cols: 1,
        tileH: 0,
        smallSize: { width: "0px", height: "0px" },
      };
    }
    // a tall narrow desktop window: one column, every tile full width, scrolling
    const narrow = boxW > 0 && boxW < 560 && boxH > boxW;
    if (narrow) {
      cols = 1;
      rows = Math.max(1, n + (rv ? 1 : 0));
    } else if (rv && n <= 3) {
      cols = n === 0 ? 1 : 2;
      rows = n >= 2 ? 2 : 1;
    } else {
      cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
      rows = Math.max(1, Math.ceil(n / cols));
      small = rv;
    }
    // the small Room view takes an extra column 40% of a tile wide
    const extra = small ? SMALL_ROOM_VIEW : 0;
    const { w, h } = box();
    const byWidth = (w - (cols - 1) * GAP - (small ? GAP : 0)) / (cols + extra);
    const byHeight = ((h - (rows - 1) * GAP) / rows) * (16 / 9);
    const tileW = narrow ? Math.floor(w) : Math.max(96, Math.floor(Math.min(byWidth, byHeight)));
    const tileH = Math.floor((tileW * 9) / 16);
    const smallW = Math.floor(tileW * SMALL_ROOM_VIEW);
    const wideMap = frameWide();
    const onPhone = (key: string) => {
      const tile = tiles().find((t) => t.key === key);
      if (!tile || tile.screen || tile.participant.isLocal) return wideMap[key] === false && !tile?.screen;
      if (tile.participant.attributes?.dh_phone === "1") return true;
      return wideMap[key] === false;
    };
    const gridKeys = [
      ...tiles().map((t) => t.key),
      ...loneRoomFaces().map(([name]) => `face:${name}`),
      ...teamScreens().map(teamKey),
    ];
    if (rv && !small && !narrow) gridKeys.push("roomview");
    const portraitKeys = gridKeys.filter(onPhone);
    if (portraitKeys.length > 0 && w > 0 && h > 0) {
      const packW = small ? Math.max(1, w - smallW - GAP) : w;
      const places = deskPlan({ keys: gridKeys, portraitKeys, width: packW, height: h, cols: narrow ? 1 : cols, gap: GAP });
      if (small) {
        places.roomview = {
          position: "absolute",
          left: `${Math.max(0, Math.round(w - smallW))}px`,
          top: "0px",
          width: `${smallW}px`,
          height: `${Math.floor((smallW * 9) / 16)}px`,
          "z-index": "1",
        };
      }
      return {
        n,
        narrow,
        phone: false,
        scroll: false,
        pipKey: undefined as string | undefined,
        places: places as Record<string, JSX.CSSProperties>,
        small,
        grid: {} as JSX.CSSProperties,
        cols,
        tileH,
        smallSize: { width: `${smallW}px`, height: `${Math.floor((smallW * 9) / 16)}px` },
      };
    }
    return {
      n,
      narrow,
      phone: false,
      scroll: false,
      pipKey: undefined as string | undefined,
      places: undefined as Record<string, JSX.CSSProperties> | undefined,
      small,
      grid: {
        "grid-template-columns": `repeat(${cols}, ${tileW}px)${small ? ` ${smallW}px` : ""}`,
        "grid-template-rows": `repeat(${rows}, ${tileH}px)`,
      },
      cols,
      tileH,
      smallSize: { width: `${smallW}px`, height: `${Math.floor((smallW * 9) / 16)}px` },
    };
  });
  // Where person i sits in the grid.
  function cellOf(i: number): JSX.CSSProperties {
    const l = layout();
    // one column: the Room view first, then everyone
    if (l.narrow) return { "grid-column": "1", "grid-row": String(i + 1 + (showingRoomView() ? 1 : 0)) };
    if (showingRoomView() && !l.small && l.n === 2) return { "grid-column": "1", "grid-row": String(i + 1) };
    if (showingRoomView() && !l.small && l.n === 3 && i === 2) return { "grid-column": "1", "grid-row": "2" };
    return { "grid-column": String((i % l.cols) + 1), "grid-row": String(Math.floor(i / l.cols) + 1) };
  }
  function roomViewCell(): JSX.CSSProperties {
    const l = layout();
    if (l.narrow) return { "grid-column": "1", "grid-row": "1" };
    if (l.small) return { "grid-column": String(l.cols + 1), "grid-row": "1", "align-self": "start", ...l.smallSize };
    if (l.n === 0) return { "grid-column": "1", "grid-row": "1" };
    if (l.n === 1) return { "grid-column": "2", "grid-row": "1" };
    if (l.n === 2) return { "grid-column": "2", "grid-row": "1 / span 2", "align-self": "center", height: `${l.tileH}px` };
    return { "grid-column": "2", "grid-row": "2" };
  }

  // ---- double-click: one screen big (Kaalob's drawings) --------------------
  // Double-click any screen (webcam, shared screen, Room view): it goes big on
  // top and every other one sits small in a centred row under it, all 16:9.
  // Double-click the big one, or Esc, to go back to the grid.
  const ROOM_VIEW_KEY = "roomview";
  const faceKey = (name: string) => `face:${name}`;
  const [focus, setFocus] = createSignal<string | undefined>();
  const order = createMemo(() => [
    ...(showingRoomView() && roomCamTrack() ? [ROOM_VIEW_KEY] : []),
    ...tiles().map((t) => t.key),
    ...loneRoomFaces().map(([name]) => faceKey(name)),
    ...teamScreens().map(teamKey),
  ]);
  // the big one left the call (or was hidden): back to the grid
  createEffect(() => {
    const big = focus();
    if (big && !order().includes(big)) setFocus(undefined);
  });
  createEffect(() => {
    if (!focus()) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setFocus(undefined);
    window.addEventListener("keydown", esc);
    onCleanup(() => window.removeEventListener("keydown", esc));
  });
  const toggleFocus = (key: string) => setFocus(focus() === key ? undefined : key);
  // A shared screen, opened big: Zoom grows it 50% and the mouse looks around it.
  const [zoomOn, setZoomOn] = createSignal(false);
  createEffect(() => {
    const key = focus();
    if (!tiles().some((t) => t.key === key && t.screen)) setZoomOn(false);
  });
  const spot = createMemo(() => {
    const big = focus();
    if (!big || layout().phone) return undefined;
    const rest = order().filter((k) => k !== big);
    const { w, h } = box();
    // The first 4 small ones sit in a row under the big one; from the 6th
    // screen on, the 5th small one and later stack in a column on its right.
    const row = rest.slice(0, SPOT_ROW_MAX);
    const col = rest.slice(SPOT_ROW_MAX);
    const r = row.length;
    const c = col.length;
    // one size for every small one: fits the row, at most about a quarter of
    // the width, and (with a column) the column fits the height
    let sw = r ? Math.min((w - (r - 1) * GAP) / r, w * 0.24) : 0;
    if (c) sw = Math.min(sw, ((h - (c - 1) * GAP) / c) * (16 / 9));
    // the big one takes what is left; then the small ones shrink until the
    // row fits under the big one and the column fits down its side
    const bigFor = (size: number) => {
      const smallH = (size * 9) / 16;
      const roomH = h - (r ? smallH + GAP : 0);
      const roomW = w - (c ? size + GAP : 0);
      return Math.min(roomW, (roomH * 16) / 9);
    };
    for (let i = 0; i < 12; i++) {
      const bw = bigFor(sw);
      const smallH = (sw * 9) / 16;
      const tall = (bw * 9) / 16 + (r ? GAP + smallH : 0);
      let next = sw;
      if (r) next = Math.min(next, (bw - (r - 1) * GAP) / r);
      if (c) next = Math.min(next, ((tall - (c - 1) * GAP) / c) * (16 / 9));
      if (next >= sw - 0.5) break;
      sw = next;
    }
    sw = Math.floor(sw);
    const sh = Math.floor((sw * 9) / 16);
    const bigW = Math.floor(bigFor(sw));
    const bigH = Math.floor((bigW * 9) / 16);
    const colH = c ? c * sh + (c - 1) * GAP : 0;
    const totalH = Math.max(bigH + (r ? GAP + sh : 0), colH);
    const totalW = bigW + (c ? GAP + sw : 0);
    const top = Math.max(0, (h - totalH) / 2);
    const left = Math.max(0, (w - totalW) / 2);
    const px = (n: number) => `${Math.round(n)}px`;
    const rects = new Map<string, JSX.CSSProperties>();
    rects.set(big, { left: px(left), top: px(top), width: px(bigW), height: px(bigH) });
    // the row, centred under the big one
    let x = left + (bigW - (r * sw + (r - 1) * GAP)) / 2;
    for (const key of row) {
      rects.set(key, { left: px(x), top: px(top + bigH + GAP), width: px(sw), height: px(sh) });
      x += sw + GAP;
    }
    // the column, down the big one's right side
    let y = top;
    for (const key of col) {
      rects.set(key, { left: px(left + bigW + GAP), top: px(y), width: px(sw), height: px(sh) });
      y += sh + GAP;
    }
    return rects;
  });
  const placeOf = (key: string, gridPlace: JSX.CSSProperties) => spot()?.get(key) ?? layout().places?.[key] ?? gridPlace;
  const openBig = (key: string) => {
    if (!layout().phone) toggleFocus(key);
  };
  // Your camera is the page to the left while other people are on the call.
  const selfPage = () => {
    if (!layout().phone) return false;
    const local = tiles().find((t) => !t.screen && t.participant.isLocal);
    return Boolean(local && layout().places?.[local.key]?.left === "-100%");
  };
  // A share left the call: leave the share pages. Your camera page stays.
  createEffect(() => {
    const keys = tiles()
      .filter((t) => t.screen)
      .map((t) => t.key);
    if (keys.length === 0) {
      setShareDragging(false);
      setShareDragX(0);
      setOpenShare(undefined);
      if (shareView() === "shelf" || shareView() === "open") setShareView("people");
      return;
    }
    const open = openShare();
    if (open && !keys.includes(open)) {
      setOpenShare(undefined);
      if (shareView() === "open") setShareView("shelf");
    }
  });
  createEffect(() => {
    if (shareView() === "self" && !selfPage()) setShareView("people");
  });
  const shareOn = () => layout().phone && shareView() !== "people";
  const shareShift = () => {
    const w = box().w;
    const view = shareView();
    const page = view === "self" ? 1 : view === "people" ? 0 : -1;
    return `translate3d(${Math.round(page * w + shareDragX())}px, 0, 0)`;
  };
  // Follow the finger. Right from the call reveals your camera. Left reveals
  // shares. The shelf does not slide onward into an entered share, and an
  // entered share only nudges: letting go is what returns to the shelf.
  function shareFollow(dx: number): number {
    const w = Math.max(1, box().w);
    const view = shareView();
    const shares = tiles().some((t) => t.screen);
    if (view === "open") return Math.max(-72, Math.min(72, dx * 0.35));
    if (view === "self") return dx < 0 ? Math.max(-w, dx) : Math.min(72, dx * 0.35);
    if (view === "people") {
      if (dx > 0) return selfPage() ? Math.min(w, dx) : Math.min(72, dx * 0.35);
      return shares ? Math.max(-w, dx) : Math.max(-72, dx * 0.35);
    }
    return dx < 0 ? Math.max(-72, dx * 0.35) : Math.min(w, dx);
  }
  let shareGesture: { x: number; y: number; id: number; locked: boolean } | undefined;
  // The page around the call opens chat on a left swipe, and the channel list
  // on a right swipe. This pager takes the first right swipe (your camera)
  // and a left swipe when someone is sharing. A right swipe while you are
  // already on your camera is left for the channel list.
  let pagerOwnsTouch = false;
  function shareDown(e: PointerEvent) {
    if (!layout().phone) return;
    const el = e.target as HTMLElement | null;
    if (!el || el.closest(".pip, .tile-inset, .inset-resize, .share-zoom, button")) return;
    shareGesture = { x: e.clientX, y: e.clientY, id: e.pointerId, locked: false };
  }
  function shareMove(e: PointerEvent) {
    const g = shareGesture;
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.locked) {
      if (Math.abs(dx) < 10) return;
      const view = shareView();
      const shares = tiles().some((t) => t.screen);
      const mine = selfPage();
      const horizontal =
        Math.abs(dx) > Math.abs(dy) &&
        ((view === "people" && dx > 0 && mine) ||
          (view === "people" && dx < 0 && shares) ||
          (view === "self" && dx < 0) ||
          (view === "self" && dx > 0) ||
          ((view === "shelf" || view === "open") && dx > 0));
      if (!horizontal) {
        shareGesture = undefined;
        return;
      }
      g.locked = true;
      pagerOwnsTouch = true;
      setShareDragging(true);
      if (tilesEl) tilesEl.scrollTop = 0;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* the pointer already ended */
      }
    }
    if (e.cancelable) e.preventDefault();
    setShareDragX(shareFollow(dx));
  }
  function shareUp(e: PointerEvent) {
    const g = shareGesture;
    if (!g || e.pointerId !== g.id) return;
    shareGesture = undefined;
    if (!g.locked) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const w = box().w || 1;
    // Already on your camera: the next right swipe opens the channel list.
    if (shareView() === "self" && dx > 0 && Math.abs(dx) >= Math.min(48, w * 0.2) && Math.abs(dx) >= Math.abs(dy)) {
      setShareDragging(false);
      setShareDragX(0);
      (e.currentTarget as HTMLElement).dispatchEvent(new CustomEvent("dh-open-channels", { bubbles: true }));
      return;
    }
    const next = shareSwipeTarget(shareView(), dx, w, {
      self: selfPage(),
      shares: tiles().some((t) => t.screen),
    });
    setShareDragging(false);
    requestAnimationFrame(() => {
      if (!shareAlive) return;
      setShareDragX(0);
      if (next !== "open") setOpenShare(undefined);
      if (next !== shareView()) setShareView(next);
      if (tilesEl) tilesEl.scrollTop = 0;
    });
  }
  function enterShare(key: string) {
    if (!layout().phone || shareView() !== "shelf") return;
    if (!tiles().some((t) => t.screen && t.key === key)) return;
    setOpenShare(key);
    setShareView("open");
    if (tilesEl) tilesEl.scrollTop = 0;
  }
  const onSharePage = (key: string) => {
    const left = layout().places?.[key]?.left;
    return typeof left === "string" && left.startsWith("calc(100%");
  };

  // A LIVE tile brought you here: once the streamer's tile is up, it goes big
  // with their stream big (webcam small), then the request is done.
  createEffect(() => {
    const uid = watchRequest();
    if (!uid) return;
    // a teamed-up player: their stream lives in the team screen, show that big
    const team = teamScreens().find((members) => members.split(",").includes(uid));
    if (team) {
      setFocus(teamKey(team));
      setWatchRequest(undefined);
      return;
    }
    const tile = tiles().find((t) => !t.screen && t.participant.identity === uid);
    if (!tile || !(streamOf(tile.participant) || streamCamOf(tile.participant))) return;
    setFocus(tile.key);
    setSwapped((prev) => new Set(prev).add(uid));
    setWatchRequest(undefined);
  });

  // One tile tree. On a phone it lives in the sliding track; on a desktop it
  // stays the direct grid. The function is created once for this call, so
  // switching the wrapper does not invent a new component type each render.
  function CallTiles() {
    return (
      <>
        <Show when={showingRoomView() && roomCamTrack()}>
          {(track) => (
            <RoomViewTile
              track={track()}
              name={`${props.channel.name} · Room view`}
              small={!spot() && layout().small}
              style={placeOf(ROOM_VIEW_KEY, roomViewCell())}
              onHide={() => hideRoomView(true)}
              onDblClick={() => openBig(ROOM_VIEW_KEY)}
            />
          )}
        </Show>
        <For each={tiles()}>
          {(tile, i) => {
            const pip = () => layout().pipKey === tile.key && !onSharePage(tile.key);
            return (
              <Tile
                style={placeOf(tile.key, cellOf(i()))}
                onDblClick={() => openBig(tile.key)}
                onPress={layout().phone && tile.screen ? () => enterShare(tile.key) : undefined}
                shareSlot={onSharePage(tile.key)}
                pip={pip()}
                onPipDrop={setPip}
                onFrame={(wide) => {
                  rememberFrame(tile.key, wide);
                  if (pip()) setPipWide(wide);
                }}
                tile={tile}
                version={version()}
                name={tile.screen ? `${nameOf(tile.participant)}'s ${screenLabel(tile)}` : nameOf(tile.participant)}
                profile={props.profiles.get(tile.participant.identity)}
                speaking={!tile.screen && speaking().has(tile.participant.identity)}
                flashing={!tile.screen && flashing().has(tile.participant.identity)}
                roomFace={tile.screen ? undefined : roomFaceOf(tile.participant.identity)}
                canZoom={Boolean(spot()) && tile.screen && focus() === tile.key}
                zoomed={zoomOn() && focus() === tile.key}
                onToggleZoom={() => setZoomOn((on) => !on)}
                forceOff={tile.participant.isLocal && !tile.screen && camWant() === false}
                stream={
                  tile.screen || inTeam().has(tile.participant.identity) || isBroadcastRoom(props.channel.roomKey)
                    ? undefined
                    : (streamOf(tile.participant) ?? streamCamOf(tile.participant))
                }
                swapped={swapped().has(tile.participant.identity)}
                onSwap={() => swap(tile.participant.identity)}
                corner={corners().get(tile.participant.identity) ?? "tl"}
                onCorner={(corner) => setCorner(tile.participant.identity, corner)}
                insetSize={insetSizes().get(tile.participant.identity) ?? INSET_MAX}
                onInsetSize={(size) => setInsetSize(tile.participant.identity, size)}
              />
            );
          }}
        </For>
        {/* people standing in the 3D room but not in the call: their webcams too */}
        <For each={loneRoomFaces()}>
          {([name, track], i) => (
            <RoomFaceTile
              style={placeOf(faceKey(name), cellOf(tiles().length + i()))}
              onDblClick={() => openBig(faceKey(name))}
              track={track}
              name={`${roomFaceName(name)} · in room`}
              username={[...props.profiles.values()].find(p => roomName(p.username || "") === name)?.username}
              color={roomFaceColor(name)}
            />
          )}
        </For>
        {/* a team's screen: each member's stream for 10 s in turn */}
        <For each={teamScreens()}>
          {(members, i) => (
            <TeamScreen
              style={placeOf(teamKey(members), cellOf(tiles().length + loneRoomFaces().length + i()))}
              onDblClick={() => openBig(teamKey(members))}
              uids={members.split(",")}
              streamFor={streamFor}
              profileOf={(uid) => props.profiles.get(uid)}
              nameOf={(uid) => displayName(props.profiles.get(uid))}
            />
          )}
        </For>
      </>
    );
  }

  function StreamMenu() {
    return (
      <div
        class="cam-wrap"
        onKeyDown={(e) => {
          if (e.key === "Escape" && streamMenu()) {
            setStreamMenu(false);
            e.preventDefault();
          }
        }}
      >
        <button
          type="button"
          class="dock-btn"
          aria-pressed={streamCamOn()}
          aria-haspopup="menu"
          aria-expanded={streamMenu()}
          onClick={() => openStreamMenu()}
        >
          <DockFace kind="stream" word={streamCamBusy() ? "Starting" : "Stream"} full={streamCamBusy() ? "Starting…" : "Stream ▴"} />
        </button>
        <Show when={streamMenu()}>
          <div class="dock-menu" role="menu" aria-label="Stream">
            <Show when={camListBusy() && camList().length === 0}>
              <button type="button" disabled>
                <span>Finding webcams…</span>
              </button>
            </Show>
            <For each={camList()}>
              {(cam) => (
                <button type="button" role="menuitem" onClick={() => void chooseStreamCam(cam.id)}>
                  <span>{cam.label}</span>
                  <span aria-hidden="true">{usingStream(cam) ? "✓" : ""}</span>
                </button>
              )}
            </For>
            <Show when={team()}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setStreamMenu(false);
                  leaveTeam();
                }}
              >
                <span>Leave the team</span>
              </button>
            </Show>
            <Show when={streamCamOn() && !camListBusy()}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setStreamMenu(false);
                  void stopStreamCam();
                }}
              >
                <span>Stream off</span>
              </button>
            </Show>
          </div>
        </Show>
      </div>
    );
  }

  return (
    <div class="voice" classList={{ phone: Boolean(room()) && layout().phone, "cams-only": Boolean(props.webcamOnly) }}>
      <Show
        when={room()}
        fallback={
          <div class="voice-lobby">
            <h2>◉ {props.channel.name}</h2>
            <p>Voice and video. Your mic and camera stay off until you turn them on.</p>
            <button class="btn primary" type="button" disabled={joining()} onClick={() => void join()}>
              {joining() ? "Joining…" : "Join"}
            </button>
            <Show when={error()}>
              <p class="form-error">{error()}</p>
            </Show>
          </div>
        }
      >
        <div
          class="tiles"
          classList={{
            spotlight: Boolean(spot()),
            narrow: !spot() && layout().narrow,
            placed: !spot() && !layout().phone && Boolean(layout().places),
            phone: layout().phone,
            "phone-scroll": layout().phone && layout().scroll,
            "share-away": shareOn(),
          }}
          ref={watchBox}
          style={spot() || layout().phone ? {} : layout().grid}
        >
          <Show when={wallStreetBig()}>
            {(style) => (
              <div class="broadcast-big" style={style()}>
                <Show when={showChartTab()}>
                  <div class="broadcast-tabs" role="tablist">
                    <button type="button" role="tab" aria-pressed={bigView() === "chart"} onClick={() => setBigView("chart")}>
                      Chart
                    </button>
                    <button type="button" role="tab" aria-pressed={bigView() === "stream"} onClick={() => setBigView("stream")}>
                      Stream
                    </button>
                    <Show when={bigView() === "chart"}>
                      <div class="broadcast-timeframes" role="group" aria-label="Timeframe">
                        <For each={TIMEFRAME_PICKER}>
                          {(t) => (
                            <button type="button" aria-pressed={chartInterval() === t.value} onClick={() => pickInterval(t.value)}>
                              {t.label}
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </Show>
                <Show when={effectiveBigView() === "chart"} fallback={
                  <Show
                    when={props.channel.roomKey === LIVING_ROOM_ROOMKEY}
                    fallback={
                      <Show when={broadcastTrack()} fallback={<div class="broadcast-big-empty">Nobody's Stream is on. Press Stream to show it here.</div>}>
                        {(track) => <BroadcastVideo track={track()} />}
                      </Show>
                    }
                  >
                    <LivingRoomBroadcast track={broadcastTrack} serverId={props.serverId} channel={props.channel} />
                  </Show>
                }>
                  <div class="tradingview-grid">
                    <TradingViewChart interval={chartInterval()} />
                    <TradingViewChart interval={chartInterval()} />
                    <TradingViewChart interval={chartInterval()} />
                  </div>
                </Show>
              </div>
            )}
          </Show>
          <Show
            when={layout().phone}
            fallback={<CallTiles />}
          >
            <div
              class="phone-track"
              classList={{ dragging: shareDragging() }}
              style={{
                ...(layout().scroll ? layout().grid : {}),
                transform: shareShift(),
              }}
              onPointerDown={shareDown}
              onPointerMove={shareMove}
              onPointerUp={shareUp}
              onPointerCancel={shareUp}
              onTouchStart={() => {
                pagerOwnsTouch = false;
              }}
              onTouchMove={(e) => {
                if (pagerOwnsTouch) e.stopPropagation();
              }}
              onTouchEnd={(e) => {
                if (!pagerOwnsTouch) return;
                pagerOwnsTouch = false;
                e.stopPropagation();
              }}
              onTouchCancel={(e) => {
                if (!pagerOwnsTouch) return;
                pagerOwnsTouch = false;
                e.stopPropagation();
              }}
            >
              <CallTiles />
            </div>
          </Show>
        </div>
        <Show when={error()}>
          <p class="form-error voice-error">{error()}</p>
        </Show>
        <div class="dock" classList={{ hidden: Boolean(props.viewOnly) }}>
          <button type="button" class="dock-btn" aria-pressed={micOn()} onClick={() => void toggle("mic")}>
            <DockFace kind={micOn() ? "mic" : "mic-off"} word={micOn() ? "Mic" : "Muted"} full={micOn() ? "Mic on" : "Mic off"} />
          </button>
          <Show
            when={props.camera}
            fallback={
              <>
                <button type="button" class="dock-btn" aria-pressed={camShown()} onClick={() => void toggle("cam")}>
                  <DockFace
                    kind={camShown() ? "cam" : "cam-off"}
                    word={camWant() === true && !camOn() ? "Starting" : "Camera"}
                    full={camWant() === true && !camOn() ? "Starting camera…" : camShown() ? "Camera on" : "Camera off"}
                  />
                </button>
                <Show when={!props.webcamOnly && !coarsePhone()}>
                  <StreamMenu />
                </Show>
              </>
            }
          >
            {(cam) => (
              <button type="button" class="dock-btn" aria-pressed={cam().on} onClick={() => cam().toggle()}>
                <DockFace kind={cam().on ? "cam" : "cam-off"} word="Camera" full={cam().on ? "Camera on" : "Camera off"} />
              </button>
            )}
          </Show>
          {/* one Share screen button; its menu shares (or stops) screen 1 and 2 */}
          <Show when={!noShare()}>
          <div
            class="share-wrap"
            classList={{ hidden: !CAN_SHARE }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && shareMenu()) {
                setShareMenu(false);
                e.preventDefault();
              }
            }}
          >
            <button
              type="button"
              class="dock-btn"
              aria-pressed={sharedCount() > 0}
              aria-haspopup="menu"
              aria-expanded={shareMenu()}
              onClick={() => setShareMenu(!shareMenu())}
            >
              <DockFace
                kind="share"
                word={sharedCount() === 0 ? "Share" : "Sharing"}
                full={sharedCount() === 0 ? "Share screen ▴" : `Sharing ${sharedCount()} ▴`}
              />
            </button>
            <Show when={shareMenu()}>
              <div class="dock-menu" role="menu" aria-label="Share screen">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShareMenu(false);
                    void toggle("screen");
                  }}
                >
                  <span>{screenOn() ? "Stop screen 1" : "Share screen 1"}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShareMenu(false);
                    void toggleSecondScreen();
                  }}
                >
                  <span>{secondOn() ? "Stop screen 2" : "Share screen 2"}</span>
                </button>
              </div>
            </Show>
          </div>
          </Show>
          {/* Attention: flash your tile for everyone, or for one person only */}
          <div
            class="share-wrap attention-wrap"
            onKeyDown={(e) => {
              if (e.key === "Escape" && attentionMenu()) {
                setAttentionMenu(false);
                e.preventDefault();
              }
            }}
          >
            <button
              type="button"
              class="dock-btn attention-btn"
              title="Make your tile flash white (3 s)"
              aria-haspopup="menu"
              aria-expanded={attentionMenu()}
              onClick={() => setAttentionMenu(!attentionMenu())}
            >
              <DockFace kind="look" word="Attention" full="✦ Attention ▴" />
            </button>
            <Show when={attentionMenu()}>
              <div class="dock-menu" role="menu" aria-label="Attention">
                <button type="button" role="menuitem" onClick={() => void callAttention()}>
                  <span>Everyone</span>
                </button>
                <For each={others()}>
                  {(p) => (
                    <button type="button" role="menuitem" onClick={() => void callAttention(p.identity)}>
                      <span>Only {nameOf(p)}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <Show when={canRemoveFromCall() && !props.viewOnly && others().length > 0}>
            <div
              class="share-wrap remove-wrap"
              onKeyDown={(e) => {
                if (e.key === "Escape" && removeMenu()) {
                  setRemoveMenu(false);
                  e.preventDefault();
                }
              }}
            >
              <button
                type="button"
                class="dock-btn"
                title="Remove someone from this call"
                aria-haspopup="menu"
                aria-expanded={removeMenu()}
                onClick={() => setRemoveMenu(!removeMenu())}
              >
                <DockFace kind="remove" word="Remove" full="Remove ▴" />
              </button>
              <Show when={removeMenu()}>
                <div class="dock-menu" role="menu" aria-label="Remove from call">
                  <For each={others()}>
                    {(p) => (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setRemoveMenu(false);
                          setRemoveAsk({ uid: p.identity, name: nameOf(p) });
                        }}
                      >
                        <span>{nameOf(p)}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>
          <Show when={roomCamTrack() && roomViewHidden() && !props.noRoomViewTile && !layout().phone}>
            <button type="button" class="dock-btn" onClick={() => hideRoomView(false)}>
              Room view
            </button>
          </Show>
          <button type="button" class="dock-btn leave" onClick={() => (props.onLeave ? props.onLeave() : leave())}>
            <DockFace kind="leave" word="Leave" full="Disconnect" />
          </button>
        </div>
        <Modal title="Remove from call" open={Boolean(removeAsk())} onClose={() => setRemoveAsk(undefined)}>
          <p class="modal-text">Remove {removeAsk()?.name} from this call? They are only disconnected, and can join again.</p>
          <div class="modal-actions">
            <button type="button" class="dock-btn" disabled={removing()} onClick={() => void confirmRemove()}>
              {removing() ? "Removing…" : "Yes, remove"}
            </button>
            <button type="button" class="dock-btn" onClick={() => setRemoveAsk(undefined)}>
              No
            </button>
          </div>
        </Modal>
        <Modal title="Team up" open={teamOffer()} onClose={() => setTeamOffer(false)}>
          <p class="modal-text">Team up with someone who is live? They have to say yes. Your face cameras stay on.</p>
          <div class="team-picks">
            <For each={otherStreamers()}>
              {(p) => (
                <button type="button" class="dock-btn" onClick={() => void askTeam(p.identity)}>
                  {nameOf(p)}
                </button>
              )}
            </For>
          </div>
          <div class="modal-actions">
            <button type="button" class="dock-btn" onClick={() => setTeamOffer(false)}>
              No
            </button>
          </div>
        </Modal>
        <Modal title="Team up" open={Boolean(teamWait())} onClose={cancelAsk}>
          <p class="modal-text">Waiting for {teamWait() ? personName(teamWait()!) : "them"} to say yes.</p>
          <div class="modal-actions">
            <button type="button" class="dock-btn" onClick={cancelAsk}>
              Cancel
            </button>
          </div>
        </Modal>
        <Modal title="Team up" open={Boolean(teamAsk())} onClose={() => void answerTeam(false)}>
          <p class="modal-text">
            {teamAsk() ? personName(teamAsk()!) : "Someone"} wants to team up. One screen shows each stream for 10 seconds.
          </p>
          <div class="modal-actions">
            <button type="button" class="dock-btn" onClick={() => void answerTeam(false)}>
              No
            </button>
            <button type="button" class="dock-btn" onClick={() => void answerTeam(true)}>
              Approve
            </button>
          </div>
        </Modal>
      </Show>
    </div>
  );
}

/**
 * A double-tap for touch screens (some phones never send a double-click):
 * two taps within 320 ms. Mouse clicks are left to onDblClick.
 */
function doubleTap(handler: () => void) {
  let last = 0;
  return (e: PointerEvent) => {
    if (e.pointerType === "mouse") return;
    const now = performance.now();
    if (now - last < 320) {
      last = 0;
      handler();
    } else last = now;
  };
}

// Phone browsers cannot share a screen: hide Share screen there.
// Stream (a second webcam) is hidden on a phone too, but for a different
// reason - it is desktop rig gear, gated on coarsePhone() below, not this.
const CAN_SHARE = typeof navigator.mediaDevices?.getDisplayMedia === "function";

function DockFace(props: { kind: "mic" | "mic-off" | "cam" | "cam-off" | "stream" | "share" | "look" | "remove" | "leave"; word: string; full: string }) {
  return (
    <>
      <span class="dock-glyph" aria-hidden="true">
        {dockIcon(props.kind)}
      </span>
      <span class="dock-word">{props.word}</span>
      <span class="dock-full">{props.full}</span>
    </>
  );
}

function dockIcon(kind: "mic" | "mic-off" | "cam" | "cam-off" | "stream" | "share" | "look" | "remove" | "leave") {
  const pen = {
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    "stroke-width": 1.8,
    "stroke-linecap": "round" as const,
    "stroke-linejoin": "round" as const,
  };
  if (kind === "mic" || kind === "mic-off") {
    return (
      <svg {...pen}>
        <rect x="9" y="2.5" width="6" height="11" rx="3" />
        <path d="M6 11a6 6 0 0 0 12 0" />
        <path d="M12 17v3.5M8 21h8" />
        {kind === "mic-off" ? <path d="M4 4l16 16" /> : null}
      </svg>
    );
  }
  if (kind === "cam" || kind === "cam-off") {
    return (
      <svg {...pen}>
        <rect x="2.5" y="6.5" width="12.5" height="11" rx="2" />
        <path d="M15 10.5 21 7.5v9L15 13.5z" />
        {kind === "cam-off" ? <path d="M4 4l16 16" /> : null}
      </svg>
    );
  }
  if (kind === "stream") {
    return (
      <svg {...pen}>
        <circle cx="12" cy="12" r="2.2" />
        <path d="M7.6 8.3a6 6 0 0 0 0 7.4M16.4 8.3a6 6 0 0 1 0 7.4" />
        <path d="M4.8 5.5a10 10 0 0 0 0 13M19.2 5.5a10 10 0 0 1 0 13" />
      </svg>
    );
  }
  if (kind === "share") {
    return (
      <svg {...pen}>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </svg>
    );
  }
  if (kind === "look") {
    return (
      <svg {...pen}>
        <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
      </svg>
    );
  }
  if (kind === "remove") {
    return (
      <svg {...pen}>
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
        <path d="M17 9h5" />
      </svg>
    );
  }
  return (
    <svg {...pen}>
      <path d="M10 7V5H5v14h5" />
      <path d="M10 12h9" />
      <path d="m16 8.5 3.5 3.5L16 15.5" />
    </svg>
  );
}

// A team screen shows each member this long, then the next (Kaalob).
const TEAM_TURN_MS = 10_000;

// The crossfade from one teammate's stream to the next (Kaalob).
const TEAM_FADE_MS = 1000;

/**
 * Teamed-up streamers: one screen in the call, each stream for 10 s in turn.
 * The next stream fades in over the current one (two videos, both playing
 * through the fade, so it never goes black). Instead of a name, every
 * teammate's profile photo sits in a row; the one playing now is bigger
 * and glows. Click a photo to stay on that player's stream; click it again
 * to go back to the rotation.
 */
function TeamScreen(props: {
  uids: string[];
  streamFor: (uid: string) => Track | undefined;
  profileOf: (uid: string) => Profile | undefined;
  nameOf: (uid: string) => string;
  style: JSX.CSSProperties;
  onDblClick: () => void;
}) {
  const videos: HTMLVideoElement[] = [];
  // which of the two videos is in front, and the track each one shows
  const [front, setFront] = createSignal(0);
  const shown: (Track | undefined)[] = [undefined, undefined];
  const [turn, setTurn] = createSignal(0);
  // a clicked face: stay on that stream until the same face is clicked again
  const [locked, setLocked] = createSignal<string | undefined>();
  const timer = window.setInterval(() => {
    if (!locked()) setTurn((t) => t + 1);
  }, TEAM_TURN_MS);
  onCleanup(() => window.clearInterval(timer));
  createEffect(() => {
    const lock = locked();
    if (lock && !props.uids.includes(lock)) setLocked(undefined);
  });
  const current = () => {
    const lock = locked();
    if (lock && props.uids.includes(lock)) return lock;
    return props.uids[turn() % props.uids.length];
  };
  // Click the face that is already locked to let the 10 s rotation resume
  // from that player. Click any other face to hold their stream instead.
  function toggleLock(uid: string, e: MouseEvent) {
    e.stopPropagation();
    setLocked((cur) => {
      if (cur === uid) {
        const i = props.uids.indexOf(uid);
        if (i >= 0) setTurn(i);
        return undefined;
      }
      return uid;
    });
  }
  const track = () => props.streamFor(current());
  let fadeTimer = 0;
  createEffect(() => {
    const t = track();
    if (!t) return;
    const now = front();
    if (shown[now] === t) return;
    if (!shown[now]) {
      // the first stream: straight in, no fade
      t.attach(videos[now]);
      shown[now] = t;
      return;
    }
    // the next stream goes into the back video, then fades in once it has a picture
    const back = 1 - now;
    const video = videos[back];
    if (shown[back] && shown[back] !== shown[now]) shown[back]!.detach(video);
    t.attach(video);
    shown[back] = t;
    const swap = () => {
      setFront(back);
      // after the fade, let the old one go (unless the same stream is still in front)
      window.clearTimeout(fadeTimer);
      fadeTimer = window.setTimeout(() => {
        const old = shown[now];
        if (old && old !== shown[back]) old.detach(videos[now]);
        shown[now] = undefined;
      }, TEAM_FADE_MS + 100);
    };
    if (video.readyState >= 2) swap();
    else video.addEventListener("loadeddata", swap, { once: true });
  });
  onCleanup(() => {
    window.clearTimeout(fadeTimer);
    shown.forEach((t, i) => t?.detach(videos[i]));
  });
  return (
    <article class="tile team-screen" style={props.style} onDblClick={props.onDblClick} onPointerUp={doubleTap(props.onDblClick)}>
      <video ref={(el) => (videos[0] = el)} class="team-video" classList={{ front: front() === 0 }} autoplay playsinline muted />
      <video ref={(el) => (videos[1] = el)} class="team-video" classList={{ front: front() === 1 }} autoplay playsinline muted />
      <span class="team-players">
        <span class="live-dot" aria-hidden="true" />
        <For each={props.uids}>
          {(uid) => (
            <button
              type="button"
              class="team-face"
              classList={{ on: uid === current(), locked: uid === locked() }}
              style={faceStyle(props.profileOf(uid))}
              title={uid === locked() ? `Locked on ${props.nameOf(uid)}. Click again to unlock.` : `Watch ${props.nameOf(uid)}`}
              aria-label={uid === locked() ? `Locked on ${props.nameOf(uid)}. Click again to unlock.` : `Watch ${props.nameOf(uid)}`}
              aria-pressed={uid === locked()}
              onClick={(e) => toggleLock(uid, e)}
              onDblClick={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
            >
              {faceText(props.profileOf(uid), props.nameOf(uid))}
            </button>
          )}
        </For>
      </span>
    </article>
  );
}

/** A webcam from someone standing in the 3D room, shown like a call tile. */
function RoomFaceTile(props: {
  track: RemoteTrack;
  name: string;
  color: string;
  username?: string;
  style: JSX.CSSProperties;
  onDblClick: () => void;
}) {
  let video: HTMLVideoElement | undefined;
  createEffect(() => {
    const t = props.track;
    if (!video) return;
    t.attach(video);
    onCleanup(() => t.detach(video!));
  });
  return (
    <article class="tile in-room" style={props.style} onDblClick={props.onDblClick} onPointerUp={doubleTap(props.onDblClick)}>
      <video ref={video} autoplay playsinline muted />
      <span class="tile-name">{props.name}<DeveloperBadge username={props.username} /></span>
    </article>
  );
}

/** The 3D room's live camera: a 16:9 tile like everyone's, small beside 4+ people. */
function RoomViewTile(props: {
  onDblClick: () => void;
  track: RemoteTrack;
  name: string;
  small: boolean;
  style: JSX.CSSProperties;
  onHide: () => void;
}) {
  let video: HTMLVideoElement | undefined;
  createEffect(() => {
    const t = props.track;
    if (!video) return;
    t.attach(video);
    onCleanup(() => t.detach(video!));
  });
  return (
    <article
      class="tile room-view"
      classList={{ small: props.small }}
      style={props.style}
      onDblClick={props.onDblClick}
      onPointerUp={doubleTap(props.onDblClick)}
    >
      <video ref={video} autoplay playsinline muted />
      <button class="room-view-hide" type="button" title="Hide the room view" onClick={props.onHide}>
        Hide
      </button>
      <span class="tile-name">
        <span class="live-dot" aria-hidden="true" /> {props.name}
      </span>
    </article>
  );
}

/**
 * A live TradingView chart: the "Advanced Chart" widget, embedded exactly
 * the way TradingView's own docs do it (a script tag holding a JSON config,
 * which TradingView's script turns into the real chart) - full toolbar,
 * symbol search, every timeframe, and the drawing-tools sidebar
 * (hide_side_toolbar: false). Each viewer's browser loads its own, fresh:
 * nobody's personal TradingView login or saved layout carries over, by
 * design - see BroadcastVideo/the Stream tab for watching one specific
 * person's own, already-logged-in chart instead.
 *
 * TradingView's free embed has no way to tell this page when you change
 * the timeframe with its own toolbar - no event, no callback, nothing this
 * page can listen for (confirmed: not documented anywhere). So "remember
 * the timeframe I set" is TIMEFRAME_PICKER below, not the widget's own
 * toolbar: a small picker this page fully controls, saved to localStorage,
 * passed in here as the chart's starting interval on every load.
 */
function TradingViewChart(props: { symbol?: string; interval: string }) {
  let container: HTMLDivElement | undefined;
  createEffect(() => {
    const el = container;
    const interval = props.interval; // tracked: rebuilds the widget when it changes
    if (!el) return;
    el.innerHTML = "";
    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    // set before appending: the external script reads this text as soon as
    // it loads, so it has to already be there, not filled in afterward
    script.text = JSON.stringify({
      autosize: true,
      symbol: props.symbol || "FX:EURUSD",
      interval,
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      allow_symbol_change: true,
      hide_side_toolbar: false,
      hide_top_toolbar: false,
      calendar: false,
      support_host: "https://www.tradingview.com",
    });
    el.append(widget, script);
  });
  return <div class="tradingview-chart" ref={container} />;
}

const WALL_STREET_INTERVAL_KEY = "dh_wallstreet_interval";
const TIMEFRAME_PICKER: { value: string; label: string }[] = [
  { value: "1", label: "1m" },
  { value: "5", label: "5m" },
  { value: "15", label: "15m" },
  { value: "60", label: "1h" },
  { value: "240", label: "4h" },
  { value: "D", label: "1D" },
];
function recallInterval(): string {
  try {
    const saved = localStorage.getItem(WALL_STREET_INTERVAL_KEY);
    return saved && TIMEFRAME_PICKER.some((t) => t.value === saved) ? saved : "60";
  } catch {
    return "60";
  }
}

/** Wall Street's big panel: just an attached track, no mirror/pip/tile semantics. */
function BroadcastVideo(props: { track: Track }) {
  let video: HTMLVideoElement | undefined;
  createEffect(() => {
    const el = video;
    if (!el) return;
    props.track.attach(el);
    onCleanup(() => props.track.detach(el));
  });
  return <video ref={video} autoplay playsinline muted />;
}

function Tile(props: {
  onDblClick: () => void;
  /** a single tap that did not turn into a drag. Phone shares use this to enter. */
  onPress?: () => void;
  /** this tile is drawn on the phone's share page, even inside a scrolling column */
  shareSlot?: boolean;
  style: JSX.CSSProperties;
  tile: TileInfo;
  version: number;
  name: string;
  profile?: Profile;
  speaking: boolean;
  /** their webcam from the 3D room, shown while their call camera is off */
  roomFace?: RemoteTrack;
  /** your own camera, already switched off (it is still stopping) */
  forceOff?: boolean;
  /** they asked for attention: a white strobe around the tile */
  flashing?: boolean;
  /** their stream (stream mode): a small picture on their tile */
  stream?: Track;
  /** the stream big and the webcam small (double-click the small one) */
  swapped?: boolean;
  onSwap?: () => void;
  /** the corner the small picture sits in; dragging it picks another */
  corner?: InsetCorner;
  onCorner?: (corner: InsetCorner) => void;
  /** the small picture's width in % of the tile (INSET_MIN to INSET_MAX) */
  insetSize?: number;
  onInsetSize?: (size: number) => void;
  /** this tile is a shared screen opened big: offer the 50% mouse zoom */
  canZoom?: boolean;
  zoomed?: boolean;
  onToggleZoom?: () => void;
  /** phone 1-on-1: this tile is your camera, dragged onto an edge of the call */
  pip?: boolean;
  onPipDrop?: (spot: PipSpot) => void;
  /** your camera's own picture: wide when landscape, tall when portrait */
  onFrame?: (wide: boolean) => void;
}) {
  let video: HTMLVideoElement | undefined;
  let inset: HTMLVideoElement | undefined;
  const track = (): Track | undefined => {
    void props.version;
    const pub = props.tile.publication;
    if (props.forceOff) return undefined;
    if (pub && !pub.isMuted && pub.track) return pub.track;
    // Their room webcam stands in only while they have never turned the call
    // camera on. Once they press Camera off (a muted camera), off means off.
    return pub ? undefined : props.roomFace;
  };

  // Stream mode: the big picture and the small one, swapped on double-click.
  const swapped = () => Boolean(props.stream && props.swapped);
  const big = () => (swapped() ? props.stream : track());
  const small = () => (props.stream ? (swapped() ? track() : props.stream) : undefined);

  createEffect(() => {
    const t = big();
    const el = video;
    if (!t || !el) return;
    t.attach(el);
    const report = () => {
      if (el.videoWidth) props.onFrame?.(el.videoWidth >= el.videoHeight);
    };
    el.addEventListener("loadedmetadata", report);
    el.addEventListener("resize", report);
    report();
    onCleanup(() => {
      el.removeEventListener("loadedmetadata", report);
      el.removeEventListener("resize", report);
      t.detach(el);
    });
  });
  createEffect(() => {
    const t = small();
    if (!t || !inset) return;
    t.attach(inset);
    onCleanup(() => t.detach(inset!));
  });

  const mirrored = () => props.tile.participant.isLocal && !props.tile.screen && !swapped();

  // Zoomed share: 50% larger, and the point under the pointer stays in view.
  const [zoomOrigin, setZoomOrigin] = createSignal("50% 50%");
  createEffect(() => {
    if (props.zoomed) setZoomOrigin("50% 50%");
  });
  function trackZoom(e: PointerEvent) {
    if (!props.zoomed) return;
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (!box.width || !box.height) return;
    const x = Math.min(100, Math.max(0, ((e.clientX - box.left) / box.width) * 100));
    const y = Math.min(100, Math.max(0, ((e.clientY - box.top) / box.height) * 100));
    setZoomOrigin(`${x}% ${y}%`);
  }

  // Drag the small picture: it follows the pointer, and on letting go it
  // snaps to the corner of the tile the pointer is in.
  const [drag, setDrag] = createSignal<{ x: number; y: number } | undefined>();
  let dragFrom: { x: number; y: number; moved: boolean } | undefined;
  function dragStart(e: PointerEvent) {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragFrom = { x: e.clientX, y: e.clientY, moved: false };
  }
  function dragMove(e: PointerEvent) {
    if (!dragFrom) return;
    const dx = e.clientX - dragFrom.x;
    const dy = e.clientY - dragFrom.y;
    if (!dragFrom.moved && Math.hypot(dx, dy) < 5) return;
    dragFrom.moved = true;
    setDrag({ x: dx, y: dy });
  }
  // Resize: drag the small picture's inner corner (the one toward the middle
  // of the tile). Toward the middle = bigger, toward its own corner = smaller.
  let resizeFrom: { x: number; width: number; tile: number } | undefined;
  function resizeStart(e: PointerEvent) {
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const inset = handle.parentElement?.getBoundingClientRect();
    const tile = handle.closest(".tile")?.getBoundingClientRect();
    if (!inset || !tile) return;
    resizeFrom = { x: e.clientX, width: inset.width, tile: tile.width };
  }
  function resizeMove(e: PointerEvent) {
    if (!resizeFrom) return;
    e.stopPropagation();
    const onLeft = (props.corner ?? "tl").endsWith("l");
    const dx = (e.clientX - resizeFrom.x) * (onLeft ? 1 : -1);
    const size = ((resizeFrom.width + dx) / resizeFrom.tile) * 100;
    props.onInsetSize?.(Math.max(INSET_MIN, Math.min(INSET_MAX, size)));
  }
  function resizeEnd(e: PointerEvent) {
    if (resizeFrom) e.stopPropagation();
    resizeFrom = undefined;
  }

  const tapTile = doubleTap(() => props.onDblClick());
  const insetTap = doubleTap(() => props.onSwap?.());
  // Phone self-view: follow the finger, then sit on the nearest edge.
  const [pipDrag, setPipDrag] = createSignal<{ x: number; y: number } | undefined>();
  let pipFrom: { x: number; y: number; moved: boolean } | undefined;
  let pressFrom: { x: number; y: number } | undefined;
  function pipDown(e: PointerEvent) {
    if (props.onPress) pressFrom = { x: e.clientX, y: e.clientY };
    if (!props.pip) return;
    if ((e.target as HTMLElement).closest(".tile-inset, .inset-resize, .share-zoom")) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pipFrom = { x: e.clientX, y: e.clientY, moved: false };
  }
  function pipMove(e: PointerEvent) {
    if (!pipFrom) return;
    const dx = e.clientX - pipFrom.x;
    const dy = e.clientY - pipFrom.y;
    if (!pipFrom.moved && Math.hypot(dx, dy) < 8) return;
    pipFrom.moved = true;
    setPipDrag({ x: dx, y: dy });
  }
  function pipUp(e: PointerEvent) {
    const from = pipFrom;
    pipFrom = undefined;
    setPipDrag(undefined);
    if (!from?.moved) return;
    e.stopPropagation();
    const stage = (e.currentTarget as HTMLElement).closest(".tiles")?.getBoundingClientRect();
    if (!stage) return;
    props.onPipDrop?.(pipSpotAt(e.clientX - stage.left, e.clientY - stage.top, stage.width, stage.height));
  }
  function dragEnd(e: PointerEvent) {
    // the tile's own double-tap (make it big) must not see this one
    e.stopPropagation();
    const from = dragFrom;
    dragFrom = undefined;
    setDrag(undefined);
    if (!from?.moved) return insetTap(e);
    const tile = (e.currentTarget as HTMLElement).closest(".tile")?.getBoundingClientRect();
    if (!tile) return;
    const top = e.clientY < tile.top + tile.height / 2;
    const left = e.clientX < tile.left + tile.width / 2;
    props.onCorner?.(`${top ? "t" : "b"}${left ? "l" : "r"}` as InsetCorner);
  }

  return (
    <article
      class="tile"
      classList={{
        speaking: props.speaking,
        screen: props.tile.screen,
        "share-slot": props.shareSlot,
        attention: Boolean(props.flashing),
        zoomed: props.zoomed,
        pip: props.pip,
        dragging: Boolean(pipDrag()),
      }}
      style={{
        ...props.style,
        ...(pipDrag() ? { transform: `translate(${pipDrag()!.x}px, ${pipDrag()!.y}px)` } : {}),
      }}
      onDblClick={props.onDblClick}
      onPointerDown={pipDown}
      onPointerUp={(e) => {
        if (pipFrom || pipDrag()) {
          pressFrom = undefined;
          pipUp(e);
          return;
        }
        tapTile(e);
        const from = pressFrom;
        pressFrom = undefined;
        if (!from || !props.onPress) return;
        if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > 10) return;
        props.onPress();
      }}
      onPointerMove={(e) => {
        if (pipFrom) pipMove(e);
        else trackZoom(e);
      }}
      onPointerCancel={pipUp}
    >
      <video
        ref={video}
        autoplay
        playsinline
        muted
        classList={{ hidden: !big(), mirror: mirrored() }}
        style={props.zoomed ? { transform: "scale(1.5)", "transform-origin": zoomOrigin() } : undefined}
      />
      <Show when={props.canZoom}>
        <button
          type="button"
          class="share-zoom"
          aria-pressed={Boolean(props.zoomed)}
          title={props.zoomed ? "Zoom off" : "Zoom in 50%. The view follows the mouse."}
          onClick={(e) => {
            e.stopPropagation();
            props.onToggleZoom?.();
          }}
          onDblClick={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
        >
          {props.zoomed ? "Zoom off" : "Zoom"}
        </button>
      </Show>
      <Show when={!big()}>
        <div class="tile-empty">
          <span class="avatar big" style={faceStyle(props.profile)}>
            {faceText(props.profile, props.name)}
          </span>
        </div>
      </Show>
      <Show when={props.stream}>
        <div
          class={`tile-inset corner-${props.corner ?? "tl"}`}
          classList={{ dragging: Boolean(drag()) }}
          style={{
            width: `${props.insetSize ?? INSET_MAX}%`,
            ...(drag() ? { transform: `translate(${drag()!.x}px, ${drag()!.y}px)` } : {}),
          }}
          title="Double-click to swap · drag to another corner"
          onPointerDown={dragStart}
          onPointerMove={dragMove}
          onPointerUp={dragEnd}
          onPointerCancel={dragEnd}
          onDblClick={(e) => {
            // swap, not the tile's own double-click (make it big)
            e.stopPropagation();
            props.onSwap?.();
          }}
        >
          <video
            ref={inset}
            autoplay
            playsinline
            muted
            classList={{ hidden: !small(), mirror: swapped() && props.tile.participant.isLocal }}
          />
          <Show when={!small()}>
            <span class="avatar" style={faceStyle(props.profile)}>
              {faceText(props.profile, props.name)}
            </span>
          </Show>
          <span
            class="inset-resize"
            title="Drag to resize"
            onPointerDown={resizeStart}
            onPointerMove={resizeMove}
            onPointerUp={resizeEnd}
            onPointerCancel={resizeEnd}
            onDblClick={(e) => e.stopPropagation()}
          />
        </div>
      </Show>
      <span class="tile-name">
        <Show when={props.stream}>
          <span class="live-dot" aria-hidden="true" />{" "}
        </Show>
        {props.name}<DeveloperBadge username={props.profile?.username} />
      </span>
    </article>
  );
}
