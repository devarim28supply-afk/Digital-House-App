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
} from "livekit-client";

import { type Channel, type Profile } from "../data/store";
import { setInCall } from "../data/where";
import { auth } from "../firebase";
import { faceStyle, faceText } from "./Shell";

/** A pass for this channel's LiveKit room, checked against Firestore. */
async function fetchPass(serverId: string, channelId: string, wall = false) {
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
};

// A 2nd shared screen rides its own named track: LiveKit keeps one
// "screen share" per person, so this one is published beside it.
const SECOND_SCREEN = "screen-2";
// Stream mode (Kaalob): still a screen share, but it rides on the sharer's
// own tile as a small picture instead of a tile of its own.
const STREAM = "stream";
const STREAM_AUDIO = "stream-audio";
type InsetCorner = "tl" | "tr" | "bl" | "br";
// the small picture's width, in % of its tile: from this big down to this small
const INSET_MAX = 30;
const INSET_MIN = 12;

// the call grid: gap between tiles, and the small Room view's width (of a tile)
const GAP = 10;
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
  /** Disconnect: the app hangs up its one call (it keeps the call alive across channels) */
  onLeave?: () => void;
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
  const showingRoomView = () => Boolean(roomCamTrack()) && !roomViewHidden() && !props.noRoomViewTile;
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
    for (const p of props.profiles.values()) if (roomName(p.username || "") === name) return p.callName || p.name || p.username;
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

  // In a call: the Online list says so ("Videochat · <channel>").
  createEffect(() => {
    if (!room()) return;
    setInCall(props.channel.name);
    onCleanup(() => setInCall(undefined));
  });

  function leave() {
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
    for (const pub of streamPubs) pub.track?.stop();
    streamPubs = [];
    setStreamOn(false);
    setRoomFaces(new Map<string, RemoteTrack>());
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
    try {
      const pass = await fetchPass(props.serverId, props.channel.id, Boolean(props.viewOnly));
      const next = new Room({ adaptiveStream: true, dynacast: true });
      next
        .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
          if (track.kind === Track.Kind.Audio) audioHost.appendChild(track.attach());
          bump();
        })
        .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
          track.detach().forEach((el) => el.remove());
          bump();
        })
        .on(RoomEvent.ActiveSpeakersChanged, (who: Participant[]) => setSpeaking(new Set(who.map((p) => p.identity))))
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
      setRoom(next);
      bump();
      // In the call: also watch the 3D room's camera (the Room view).
      if (props.roomView) startRoomView(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join the call.");
    } finally {
      setJoining(false);
    }
  }

  if (props.autoJoin) queueMicrotask(() => void join());

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
  async function toggleStream() {
    const me = room()?.localParticipant;
    if (!me) return;
    setError("");
    if (streamPubs.length) {
      await stopStream();
      return;
    }
    try {
      // a game or a window, smooth, with its sound if "share audio" is ticked
      const media = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
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
          simulcast: false,
          videoEncoding: { maxBitrate: 4_500_000, maxFramerate: 30 },
        }),
      ];
      const audio = media.getAudioTracks()[0];
      if (audio) streamPubs.push(await me.publishTrack(audio, { name: STREAM_AUDIO, source: Track.Source.ScreenShareAudio }));
      setStreamOn(true);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "NotAllowedError")) {
        setError(err instanceof Error ? err.message : "That could not be streamed.");
      }
    }
    bump();
  }
  async function stopStream() {
    const pubs = streamPubs;
    streamPubs = [];
    setStreamOn(false);
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
      .setCameraEnabled(on)
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

  async function toggle(kind: "mic" | "cam" | "screen") {
    if (kind === "cam") return toggleCam();
    const me = room()?.localParticipant;
    if (!me) return;
    setError("");
    try {
      if (kind === "mic") await me.setMicrophoneEnabled(!me.isMicrophoneEnabled);
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
    return profile?.callName || profile?.name || p.name || "Member";
  };

  // ---- the layout (Kaalob's drawings) --------------------------------------
  // Every tile is one 16:9 size; the Room view is one of the tiles:
  //   1 person   [you][Room view]
  //   2 people   the two stacked on the left, the Room view on the right, centred
  //   3 people   a 2x2 grid, the Room view in the last spot
  //   4 or more  everyone in the grid, the Room view small at the top right
  const [box, setBox] = createSignal({ w: 0, h: 0 });
  let boxObserver: ResizeObserver | undefined;
  function watchBox(el: HTMLDivElement) {
    boxObserver?.disconnect();
    boxObserver = new ResizeObserver(([entry]) => setBox({ w: entry.contentRect.width, h: entry.contentRect.height }));
    boxObserver.observe(el);
  }
  onCleanup(() => boxObserver?.disconnect());

  const people = () => tiles().length + loneRoomFaces().length;
  const layout = createMemo(() => {
    const n = people();
    const rv = showingRoomView();
    let cols: number;
    let rows: number;
    let small = false;
    if (rv && n <= 3) {
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
    const tileW = Math.max(96, Math.floor(Math.min(byWidth, byHeight)));
    const tileH = Math.floor((tileW * 9) / 16);
    const smallW = Math.floor(tileW * SMALL_ROOM_VIEW);
    return {
      n,
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
    if (showingRoomView() && !l.small && l.n === 2) return { "grid-column": "1", "grid-row": String(i + 1) };
    if (showingRoomView() && !l.small && l.n === 3 && i === 2) return { "grid-column": "1", "grid-row": "2" };
    return { "grid-column": String((i % l.cols) + 1), "grid-row": String(Math.floor(i / l.cols) + 1) };
  }
  function roomViewCell(): JSX.CSSProperties {
    const l = layout();
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
  const spot = createMemo(() => {
    const big = focus();
    if (!big) return undefined;
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
  const placeOf = (key: string, gridPlace: JSX.CSSProperties) => spot()?.get(key) ?? gridPlace;

  return (
    <div class="voice">
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
        <div class="tiles" classList={{ spotlight: Boolean(spot()) }} ref={watchBox} style={spot() ? {} : layout().grid}>
          <Show when={showingRoomView() && roomCamTrack()}>
            {(track) => (
              <RoomViewTile
                track={track()}
                name={`${props.channel.name} · Room view`}
                small={!spot() && layout().small}
                style={placeOf(ROOM_VIEW_KEY, roomViewCell())}
                onHide={() => hideRoomView(true)}
                onDblClick={() => toggleFocus(ROOM_VIEW_KEY)}
              />
            )}
          </Show>
          <For each={tiles()}>
            {(tile, i) => (
              <Tile
                style={placeOf(tile.key, cellOf(i()))}
                onDblClick={() => toggleFocus(tile.key)}
                tile={tile}
                version={version()}
                name={tile.screen ? `${nameOf(tile.participant)}'s ${tile.second ? "2nd screen" : "screen"}` : nameOf(tile.participant)}
                profile={props.profiles.get(tile.participant.identity)}
                speaking={!tile.screen && speaking().has(tile.participant.identity)}
                roomFace={tile.screen ? undefined : roomFaceOf(tile.participant.identity)}
                forceOff={tile.participant.isLocal && !tile.screen && camWant() === false}
                stream={tile.screen ? undefined : streamOf(tile.participant)}
                swapped={swapped().has(tile.participant.identity)}
                onSwap={() => swap(tile.participant.identity)}
                corner={corners().get(tile.participant.identity) ?? "tl"}
                onCorner={(corner) => setCorner(tile.participant.identity, corner)}
                insetSize={insetSizes().get(tile.participant.identity) ?? INSET_MAX}
                onInsetSize={(size) => setInsetSize(tile.participant.identity, size)}
              />
            )}
          </For>
          {/* people standing in the 3D room but not in the call: their webcams too */}
          <For each={loneRoomFaces()}>
            {([name, track], i) => (
              <RoomFaceTile
                style={placeOf(faceKey(name), cellOf(tiles().length + i()))}
                onDblClick={() => toggleFocus(faceKey(name))}
                track={track}
                name={`${roomFaceName(name)} · in room`}
                color={roomFaceColor(name)}
              />
            )}
          </For>
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
              <button type="button" class="dock-btn" aria-pressed={camShown()} onClick={() => void toggle("cam")}>
                {camWant() === true && !camOn() ? "Starting camera…" : camShown() ? "Camera on" : "Camera off"}
              </button>
            }
          >
            {(cam) => (
              <button type="button" class="dock-btn" aria-pressed={cam().on} onClick={() => cam().toggle()}>
                {cam().on ? "Camera on" : "Camera off"}
              </button>
            )}
          </Show>
          {/* one Share screen button; its menu shares (or stops) screen 1 and 2 */}
          <div class="share-wrap">
            <button
              type="button"
              class="dock-btn"
              aria-pressed={sharedCount() > 0}
              aria-expanded={shareMenu()}
              onClick={() => setShareMenu(!shareMenu())}
            >
              {sharedCount() === 0 ? "Share screen" : `Sharing ${sharedCount()}`} ▴
            </button>
            <Show when={shareMenu()}>
              <div class="share-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShareMenu(false);
                    void toggle("screen");
                  }}
                >
                  {screenOn() ? "Stop screen 1" : "Share screen 1"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShareMenu(false);
                    void toggleSecondScreen();
                  }}
                >
                  {secondOn() ? "Stop screen 2" : "Share screen 2"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShareMenu(false);
                    void toggleStream();
                  }}
                >
                  {streamOn() ? "Stop stream mode" : "Start stream mode"}
                </button>
              </div>
            </Show>
          </div>
          <Show when={roomCamTrack() && roomViewHidden() && !props.noRoomViewTile}>
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

/** A webcam from someone standing in the 3D room, shown like a call tile. */
function RoomFaceTile(props: {
  track: RemoteTrack;
  name: string;
  color: string;
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
    <article class="tile in-room" style={props.style} onDblClick={props.onDblClick}>
      <video ref={video} autoplay playsinline muted />
      <span class="tile-name">{props.name}</span>
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
    <article class="tile room-view" classList={{ small: props.small }} style={props.style} onDblClick={props.onDblClick}>
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
    if (!t || !video) return;
    t.attach(video);
    onCleanup(() => t.detach(video!));
  });
  createEffect(() => {
    const t = small();
    if (!t || !inset) return;
    t.attach(inset);
    onCleanup(() => t.detach(inset!));
  });

  const mirrored = () => props.tile.participant.isLocal && !props.tile.screen && !swapped();

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

  function dragEnd(e: PointerEvent) {
    const from = dragFrom;
    dragFrom = undefined;
    setDrag(undefined);
    if (!from?.moved) return;
    const tile = (e.currentTarget as HTMLElement).closest(".tile")?.getBoundingClientRect();
    if (!tile) return;
    const top = e.clientY < tile.top + tile.height / 2;
    const left = e.clientX < tile.left + tile.width / 2;
    props.onCorner?.(`${top ? "t" : "b"}${left ? "l" : "r"}` as InsetCorner);
  }

  return (
    <article class="tile" classList={{ speaking: props.speaking, screen: props.tile.screen }} style={props.style} onDblClick={props.onDblClick}>
      <video ref={video} autoplay playsinline muted classList={{ hidden: !big(), mirror: mirrored() }} />
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
        {props.name}
      </span>
    </article>
  );
}
