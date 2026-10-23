import { Show, createEffect, createSignal, onCleanup, untrack } from "solid-js";

import { type RemoteTrack, Room, RoomEvent, Track } from "livekit-client";

import { auth } from "../firebase";

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
 * In that same videochat already (frozen), the tile holds a still picture
 * instead: you see the stream in the call, so the sidebar downloads nothing.
 */
export function LiveTile(props: {
  serverId: string;
  channelId: string;
  /** the streamer: their uid is their name in the call */
  uid: string;
  name: string;
  /** you are in the streamer's videochat: hold a still picture, no live preview */
  frozen: boolean;
  onOpen: () => void;
}) {
  let video: HTMLVideoElement | undefined;
  let face: HTMLVideoElement | undefined;
  // This preview's own name in the call (one per LIVE tile, so two tiles on
  // one screen never knock each other out); the token server makes it
  // invisible and watch-only, so nobody sees an extra person.
  const peekTag = Math.random().toString(36).slice(2, 10);
  const [playing, setPlaying] = createSignal(false);
  const [faceOn, setFaceOn] = createSignal(false);
  // the frozen picture: the stream, and their webcam if it was on
  const [snapshot, setSnapshot] = createSignal<{ stream: string; face?: string } | undefined>();

  // Frozen: take the still from the live preview, then let it go. (Untracked:
  // the webcam going on or off must not restart the connection below.)
  function freezeNow() {
    return untrack(() => {
      const stream = still(video, 480);
      if (!stream) return false;
      setSnapshot({ stream, face: faceOn() ? still(face, 200) : undefined });
      return true;
    });
  }

  // Live (or frozen without a picture yet): be connected. Frozen with a
  // picture: not connected at all.
  createEffect(() => {
    if (props.frozen && snapshot()) return;
    if (!props.frozen && untrack(snapshot)) setSnapshot(undefined);
    let room: Room | undefined;
    let gone = false;
    let retry = 0;
    const attach = (track: RemoteTrack) => {
      if (!video) return;
      track.attach(video);
      setPlaying(true);
    };
    // frozen and waiting for a picture: take one once frames arrive
    const onFrame = () => {
      if (props.frozen && !snapshot()) window.setTimeout(freezeNow, 400);
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
            if (participant.identity !== props.uid || track.kind !== Track.Kind.Video) return;
            if (pub.trackName === "stream") attach(track);
            // their webcam, small in the corner
            else if (pub.source === Track.Source.Camera && face) {
              track.attach(face);
              setFaceOn(!pub.isMuted);
            }
          })
          .on(RoomEvent.TrackUnsubscribed, (_track, pub, participant) => {
            if (participant.identity !== props.uid) return;
            if (pub.trackName === "stream") setPlaying(false);
            else if (pub.source === Track.Source.Camera) setFaceOn(false);
          })
          .on(RoomEvent.TrackMuted, (pub, participant) => {
            if (participant.identity === props.uid && pub.source === Track.Source.Camera) setFaceOn(false);
          })
          .on(RoomEvent.TrackUnmuted, (pub, participant) => {
            if (participant.identity === props.uid && pub.source === Track.Source.Camera) setFaceOn(true);
          })
          .on(RoomEvent.Disconnected, () => {
            setPlaying(false);
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
      setPlaying(false);
      void room?.disconnect();
    });
  });

  return (
    <button
      type="button"
      class="room-tile live-tile"
      classList={{ frozen: Boolean(snapshot()) }}
      title={`${props.name} is live`}
      onClick={props.onOpen}
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
        classList={{ hidden: !faceOn() || Boolean(snapshot()) }}
      />
      <Show when={snapshot()?.face}>{(src) => <img class="live-tile-face" src={src()} alt="" />}</Show>
      <span class="live-badge">LIVE</span>
      <span class="room-tile-name">{props.name}</span>
    </button>
  );
}
