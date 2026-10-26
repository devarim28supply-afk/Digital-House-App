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
  VideoPresets,
} from "livekit-client";

import { type SeatControl, startSeats } from "../data/seats";
import { displayName, type Channel, type Profile } from "../data/store";
import { setCallFaces } from "../data/callFaces";
import { setInCall, setStreamingIn, setWatchRequest, watchRequest } from "../data/where";
import { auth } from "../firebase";
import { faceStyle, faceText } from "./Shell";
import { type PipSpot, type ShareView, phonePlan, phoneSharePlaces, pipSpotAt, shareSwipeTarget } from "./phoneCallLayout";

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
// The Stream menu. A second webcam, beside the primary camera, shown as its own screen.
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
const STREAM_CAM_PUBLISH: TrackPublishOptions = {
  name: STREAM_CAM,
  source: Track.Source.Unknown,
  simulcast: false,
  degradationPreference: "maintain-framerate",
  videoEncoding: { maxBitrate: 700_000, maxFramerate: 30, priority: "low" },
};
// stream mode sizes: full 1080p, or a lighter 720p (about half the work and upload)
// Sized for a home upload: every extra copy (simulcast layer) is sent too, so
// only one small 360p copy goes with the stream, for the LIVE tile previews.
const STREAM_QUALITY = {
  "1080": { width: 1920, height: 1080, maxBitrate: 3_000_000, layers: [VideoPresets.h360] },
  "720": { width: 1280, height: 720, maxBitrate: 1_500_000, layers: [VideoPresets.h360] },
} as const;
type StreamQuality = keyof typeof STREAM_QUALITY;
// Attention (Kaalob, Deaf-first): your tile strobes white for everyone, 3 s.
const ATTENTION_TOPIC = "attention";
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
}) {
  const [room, setRoom] = createSignal<Room | undefined>();
  const [roomCamTrack, setRoomCamTrack] = createSignal<RemoteTrack | undefined>();
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
      // The wall in a 3D room (viewOnly) is a page turned in 3D space: LiveKit's
      // "is this video on screen?" check misjudges it and paused the wall's
      // videos (black). The wall gets every video as it is; tiles here keep it.
      // H.264 for everything we send: Chrome hands it to the graphics card's own
      // video encoder (NVENC), so a game holding the GPU's 3D engine near 100%
      // no longer starves the webcam and the stream (Kaalob's slow webcam).
      const next = new Room({
        adaptiveStream: !props.viewOnly,
        dynacast: true,
        publishDefaults: { videoCodec: "h264" },
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
  const sharedCount = () => (screenOn() ? 1 : 0) + (secondOn() ? 1 : 0) + (streamOn() ? 1 : 0);
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
  async function toggleStream(quality: StreamQuality = "1080") {
    const me = room()?.localParticipant;
    if (!me) return;
    setError("");
    if (streamPubs.length) {
      await stopStream();
      return;
    }
    try {
      // a game or a window, smooth, with its sound if "share audio" is ticked
      const size = STREAM_QUALITY[quality];
      const media = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 }, width: { ideal: size.width }, height: { ideal: size.height } },
        audio: true,
      });
      const video = media.getVideoTracks()[0];
      if (!video) return;
      video.contentHint = "motion";
      video.addEventListener("ended", () => void stopStream());
      streamPubs = [
        await me.publishTrack(video, {
          name: STREAM,
          source: Track.Source.Unknown,
          // sent in three sizes: the small LIVE tile previews and small tiles
          // take a small one, the big view takes the full 1080p
          simulcast: true,
          // low priority: when the upload is tight, the stream gives way to the webcam
          videoEncoding: { maxBitrate: size.maxBitrate, maxFramerate: 30, priority: "low" },
          videoSimulcastLayers: [...size.layers],
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

  // ---- team up: two (or more) streams of the same game share one LIVE tile ---
  const [team, setTeam] = createSignal<string | undefined>();
  /** Team up with another streamer here (their uid), or undefined to leave the team. */
  function teamUp(uid: string | undefined) {
    setTeam(uid);
    if (streamOn()) setStreamingIn({ serverId: props.serverId, channelId: props.channel.id, ...(uid ? { team: uid } : {}) });
  }
  // the other people streaming in this videochat: who you can team up with
  const otherStreamers = () => [...(room()?.remoteParticipants.values() ?? [])].filter((p) => streamOf(p));

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
    const attempt = active
      .setCameraEnabled(on, undefined, CAMERA_PUBLISH)
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
    return result;
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
    if (pub?.track) await room()?.localParticipant.unpublishTrack(pub.track).catch(() => {});
    pub?.track?.stop();
    bump();
  }

  async function startStreamCam() {
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
      if (kind === "screen") await me.setScreenShareEnabled(!me.isScreenShareEnabled, { audio: true });
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
        if (pub.trackName === STREAM || pub.trackName === STREAM_AUDIO) continue;
        const second = pub.trackName === SECOND_SCREEN;
        const streamCam = pub.trackName === STREAM_CAM;
        if (pub.kind !== Track.Kind.Video || pub.isMuted || (pub.source !== Track.Source.ScreenShare && !second && !streamCam)) continue;
        screens.push({ key: `${p.identity}:${pub.trackSid}`, participant: p, publication: pub, screen: true, second, streamCam });
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
  // Desktop: every tile is one 16:9 size; the Room view is one of the tiles:
  //   1 person   [you][Room view]
  //   2 people   the two stacked on the left, the Room view on the right, centred
  //   3 people   a 2x2 grid, the Room view in the last spot
  //   4 or more  everyone in the grid, the Room view small at the top right
  // Phone (pointer is coarse and the short side is under 540px): the room view
  // stays hidden. 1-on-1 is the other person full-screen and your camera small,
  // dragged to the top, left, right, or bottom. 3 people: two across the top,
  // one across a taller bottom. 4 sideways: an even 2x2. 4 upright: one column.
  // 5 or more stack and scroll. The picture inside each cell stays whole 16:9.
  // A screen share is not one of those cells. It sits on the next page: swipe
  // right to left to see the shares, tap one to open it beside the person
  // sharing it, both as 16:9. Swipe left to right to come back.
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
    return participant ? streamOf(participant) : undefined;
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
      const plan = phonePlan({
        keys,
        localKey: local?.key,
        landscape,
        width,
        height,
        pipSpot: pipSpot(),
        pipWide: pipWide(),
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
  // A share left the call: drop back. None left: the people page only.
  createEffect(() => {
    const keys = tiles()
      .filter((t) => t.screen)
      .map((t) => t.key);
    if (keys.length === 0) {
      setShareDragging(false);
      setShareDragX(0);
      setOpenShare(undefined);
      setShareView("people");
      return;
    }
    const open = openShare();
    if (open && !keys.includes(open)) {
      setOpenShare(undefined);
      if (shareView() === "open") setShareView("shelf");
    }
  });
  const shareOn = () => layout().phone && tiles().some((t) => t.screen) && shareView() !== "people";
  const shareShift = () => {
    const w = box().w;
    const page = shareOn() ? 1 : 0;
    return `translate3d(${Math.round(-page * w + shareDragX())}px, 0, 0)`;
  };
  // Follow the finger. The shelf does not slide onward into an entered share,
  // and an entered share only nudges: letting go is what returns to the shelf.
  function shareFollow(dx: number): number {
    const w = Math.max(1, box().w);
    const view = shareView();
    if (view === "open") return Math.max(-72, Math.min(72, dx * 0.35));
    if (view === "people") return dx > 0 ? Math.min(72, dx * 0.35) : Math.max(-w, dx);
    return dx < 0 ? Math.max(-72, dx * 0.35) : Math.min(w, dx);
  }
  let shareGesture: { x: number; y: number; id: number; locked: boolean } | undefined;
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
      if (Math.abs(dx) <= Math.abs(dy) || !tiles().some((t) => t.screen)) {
        shareGesture = undefined;
        return;
      }
      g.locked = true;
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
    const next = shareSwipeTarget(shareView(), dx, box().w || 1);
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
    if (!tile || !streamOf(tile.participant)) return;
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
                onFrame={pip() ? setPipWide : undefined}
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
                stream={tile.screen || inTeam().has(tile.participant.identity) ? undefined : streamOf(tile.participant)}
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
          {streamCamBusy() ? "Starting…" : "Stream"} ▴
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
    <div class="voice" classList={{ phone: Boolean(room()) && layout().phone }}>
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
            phone: layout().phone,
            "phone-scroll": layout().phone && layout().scroll,
            "share-away": shareOn(),
          }}
          ref={watchBox}
          style={spot() || layout().phone ? {} : layout().grid}
        >
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
              onTouchStart={(e) => {
                if (layout().phone && tiles().some((t) => t.screen)) e.stopPropagation();
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
            {micOn() ? "Mic on" : "Mic off"}
          </button>
          <Show
            when={props.camera}
            fallback={
              <>
                <button type="button" class="dock-btn" aria-pressed={camShown()} onClick={() => void toggle("cam")}>
                  {camWant() === true && !camOn() ? "Starting camera…" : camShown() ? "Camera on" : "Camera off"}
                </button>
                <StreamMenu />
              </>
            }
          >
            {(cam) => (
              <button type="button" class="dock-btn" aria-pressed={cam().on} onClick={() => cam().toggle()}>
                {cam().on ? "Camera on" : "Camera off"}
              </button>
            )}
          </Show>
          {/* one Share screen button; its menu shares (or stops) screen 1 and 2 */}
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
              {sharedCount() === 0 ? "Share screen" : `Sharing ${sharedCount()}`} ▴
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
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShareMenu(false);
                    void toggleStream("1080");
                  }}
                >
                  <span>{streamOn() ? "Stop stream mode" : "Start stream mode (1080p)"}</span>
                </button>
                <Show when={!streamOn()}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShareMenu(false);
                      void toggleStream("720");
                    }}
                  >
                    <span>Start stream mode (720p, lighter)</span>
                  </button>
                </Show>
                {/* streaming: team up with another streamer here (one LIVE tile) */}
                <Show when={streamOn()}>
                  <For each={otherStreamers()}>
                    {(p) => (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setShareMenu(false);
                          teamUp(p.identity);
                        }}
                      >
                        <span>{team() === p.identity ? `Teamed up with ${nameOf(p)}` : `Team up with ${nameOf(p)}`}</span>
                        <span aria-hidden="true">{team() === p.identity ? "✓" : ""}</span>
                      </button>
                    )}
                  </For>
                  <Show when={team()}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setShareMenu(false);
                        teamUp(undefined);
                      }}
                    >
                      <span>Leave the team</span>
                    </button>
                  </Show>
                </Show>
              </div>
            </Show>
          </div>
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
              ✦ Attention ▴
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
          <Show when={roomCamTrack() && roomViewHidden() && !props.noRoomViewTile && !layout().phone}>
            <button type="button" class="dock-btn" onClick={() => hideRoomView(false)}>
              Room view
            </button>
          </Show>
          <button type="button" class="dock-btn leave" onClick={() => (props.onLeave ? props.onLeave() : leave())}>
            Disconnect
          </button>
        </div>
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

// Phone browsers cannot share a screen: hide Share screen and stream mode there.
const CAN_SHARE = typeof navigator.mediaDevices?.getDisplayMedia === "function";

// A team screen shows each member this long, then the next (Kaalob).
const TEAM_TURN_MS = 10_000;

// The crossfade from one teammate's stream to the next (Kaalob).
const TEAM_FADE_MS = 1000;

/**
 * Teamed-up streamers: one screen in the call, each stream for 10 s in turn.
 * The next stream fades in over the current one (two videos, both playing
 * through the fade, so it never goes black). Instead of a name, every
 * teammate's profile photo sits in a row; the one playing now is bigger
 * and glows.
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
  const timer = window.setInterval(() => setTurn((t) => t + 1), TEAM_TURN_MS);
  onCleanup(() => window.clearInterval(timer));
  const current = () => props.uids[turn() % props.uids.length];
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
            <span
              class="team-face"
              classList={{ on: uid === current() }}
              style={faceStyle(props.profileOf(uid))}
              title={props.nameOf(uid)}
              aria-label={props.nameOf(uid)}
            >
              {faceText(props.profileOf(uid), props.nameOf(uid))}
            </span>
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
