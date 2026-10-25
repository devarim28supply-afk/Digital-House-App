import { DeveloperBadge } from "./DeveloperBadge";
import { For, Show, createEffect, createSignal, onCleanup, untrack } from "solid-js";

import { type RemoteTrack, Room, RoomEvent, Track } from "livekit-client";

import { auth } from "../firebase";

// A team's LIVE tile shows each member this long, then the next (Kaalob).
const ROTATE_MS = 10_000;

/** A still picture of a video element (a small JPEG), or undefined with no frame yet. */
function still(video: HTMLVideoElement | undefined, width: number) {
  if (!video?.videoWidth) return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.round((width * video.videoHeight) / video.videoWidth);
  canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.75);
}

/**
 * Someone is in stream mode: a LIVE tile at the top of the sidebar playing
 * their stream (no sound) with their webcam small in the corner, their name
 * at the bottom and a glowing red LIVE (Kaalob's drawings). Clicking it takes
 * you into that videochat with their stream big.
 *
 * A team (streamers who teamed up for the same game) shares one tile: it
 * shows each member for 10 seconds, then the next, round and round.
 *
 * In that same videochat already (frozen), the tile holds a still picture
 * instead: you see the stream in the call, so the sidebar downloads nothing.
 */
export function LiveTile(props: {
  serverId: string;
  channelId: string;
  /** the streamer(s): their uid is their name in the call */
  uids: string[];
  nameOf: (uid: string) => string;
  usernameOf?: (uid: string) => string | undefined;
  /** you are in the streamers' videochat: hold a still picture, no live preview */
  frozen: boolean;
  /** clicked: open this streamer (the one showing now) */
  onOpen: (uid: string) => void;
}) {
  let video: HTMLVideoElement | undefined;
  let face: HTMLVideoElement | undefined;
  // This preview's own name in the call (one per LIVE tile, so two tiles on
  // one screen never knock each other out); the token server makes it
  // invisible and watch-only, so nobody sees an extra person.
  const peekTag = Math.random().toString(36).slice(2, 10);
  // every member's stream and webcam, as they arrive
  const [streams, setStreams] = createSignal(new Map<string, RemoteTrack>());
  const [faces, setFaces] = createSignal(new Map<string, RemoteTrack>());
  const put = (set: typeof setStreams, uid: string, track: RemoteTrack | undefined) =>
    set((prev) => {
      const next = new Map(prev);
      if (track) next.set(uid, track);
      else next.delete(uid);
      return next;
    });

  // who is showing now; a team turns every 10 seconds
  const [turn, setTurn] = createSignal(0);
  createEffect(() => {
    if (props.uids.length < 2) return;
    const timer = window.setInterval(() => setTurn((t) => t + 1), ROTATE_MS);
    onCleanup(() => window.clearInterval(timer));
  });
  const current = () => props.uids[turn() % props.uids.length] ?? props.uids[0];
  const stream = () => streams().get(current());
  const camera = () => faces().get(current());

  // the frozen picture: the stream, and their webcam if it was on
  const [snapshot, setSnapshot] = createSignal<{ stream: string; face?: string } | undefined>();
  // Frozen: take the still from the live preview, then let it go. (Untracked:
  // tracks coming and going must not restart the connection below.)
  function freezeNow() {
    return untrack(() => {
      const picture = still(video, 480);
      if (!picture || !stream()) return false;
      setSnapshot({ stream: picture, face: camera() ? still(face, 200) : undefined });
      return true;
    });
  }

  // show the current member's stream and webcam
  createEffect(() => {
    const t = stream();
    if (!t || !video) return;
    t.attach(video);
    onCleanup(() => t.detach(video!));
  });
  createEffect(() => {
    const t = camera();
    if (!t || !face) return;
    t.attach(face);
    onCleanup(() => t.detach(face!));
  });

  // Live (or frozen without a picture yet): be connected. Frozen with a
  // picture: not connected at all.
  createEffect(() => {
    if (props.frozen && snapshot()) return;
    if (!props.frozen && untrack(snapshot)) setSnapshot(undefined);
    const members = new Set(props.uids);
    let room: Room | undefined;
    let gone = false;
    let retry = 0;
    // frozen and waiting for a picture: take one once frames arrive
    const onFrame = () => {
      if (props.frozen && !untrack(snapshot)) window.setTimeout(freezeNow, 400);
    };
    video?.addEventListener("loadeddata", onFrame);
    async function connect() {
      try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken || gone) return;
        const res = await fetch("/api/dh-token", {
          method: "POST",
          headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ serverId: props.serverId, channelId: props.channelId, peek: peekTag }),
        });
        const pass = (await res.json()) as { url?: string; token?: string };
        if (!res.ok || !pass.url || !pass.token || gone) throw new Error("no pass");
        const next = new Room({ adaptiveStream: true });
        next
          .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub, participant) => {
            if (!members.has(participant.identity) || track.kind !== Track.Kind.Video) return;
            if (pub.trackName === "stream") put(setStreams, participant.identity, track);
            // their webcam, small in the corner
            else if (pub.source === Track.Source.Camera && !pub.isMuted) put(setFaces, participant.identity, track);
          })
          .on(RoomEvent.TrackUnsubscribed, (_track, pub, participant) => {
            if (pub.trackName === "stream") put(setStreams, participant.identity, undefined);
            else if (pub.source === Track.Source.Camera) put(setFaces, participant.identity, undefined);
          })
          .on(RoomEvent.TrackMuted, (pub, participant) => {
            if (pub.source === Track.Source.Camera) put(setFaces, participant.identity, undefined);
          })
          .on(RoomEvent.TrackUnmuted, (pub, participant) => {
            if (members.has(participant.identity) && pub.source === Track.Source.Camera && pub.track) {
              put(setFaces, participant.identity, pub.track as RemoteTrack);
            }
          })
          .on(RoomEvent.Disconnected, () => {
            setStreams(new Map());
            setFaces(new Map());
            if (!gone) retry = window.setTimeout(() => void connect(), 3000);
          });
        await next.connect(pass.url, pass.token);
        if (gone) return void next.disconnect();
        room = next;
      } catch {
        if (!gone) retry = window.setTimeout(() => void connect(), 5000);
      }
    }
    // already showing frames: freeze straight away, no reconnect needed
    if (props.frozen && freezeNow()) return;
    void connect();
    onCleanup(() => {
      gone = true;
      window.clearTimeout(retry);
      video?.removeEventListener("loadeddata", onFrame);
      setStreams(new Map());
      setFaces(new Map());
      void room?.disconnect();
    });
  });

  const playing = () => Boolean(stream());
  const names = () => props.uids.map(props.nameOf).join(" & ");

  return (
    <button
      type="button"
      class="room-tile live-tile"
      classList={{ frozen: Boolean(snapshot()) }}
      title={`${names()} ${props.uids.length > 1 ? "are" : "is"} live`}
      onClick={() => props.onOpen(current())}
    >
      <video ref={video} autoplay playsinline muted classList={{ hidden: !playing() || Boolean(snapshot()) }} />
      <Show when={snapshot()}>{(snap) => <img class="live-tile-still" src={snap().stream} alt="" />}</Show>
      <Show when={!playing() && !snapshot()}>
        <span class="live-tile-wait" />
      </Show>
      <video
        ref={face}
        class="live-tile-face"
        autoplay
        playsinline
        muted
        classList={{ hidden: !camera() || Boolean(snapshot()) }}
      />
      <Show when={snapshot()?.face}>{(src) => <img class="live-tile-face" src={src()} alt="" />}</Show>
      <span class="live-badge">LIVE</span>
      <span class="room-tile-name">
        {props.nameOf(current())}<DeveloperBadge username={props.usernameOf?.(current())} />
        {/* a team: which member is showing */}
        <Show when={props.uids.length > 1}>
          <span class="live-team" aria-hidden="true">
            <For each={props.uids}>{(uid) => <i classList={{ on: uid === current() }} />}</For>
          </span>
        </Show>
      </span>
    </button>
  );
}
