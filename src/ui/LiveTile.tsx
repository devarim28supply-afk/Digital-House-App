import { Show, createSignal, onCleanup, onMount } from "solid-js";

import { type RemoteTrack, Room, RoomEvent, Track } from "livekit-client";

import { auth } from "../firebase";

// The preview's own name in the call (one per screen): the token server makes
// it invisible and watch-only, so nobody sees an extra person.
const PEEK_TAG = Math.random().toString(36).slice(2, 8);

/**
 * Someone is in stream mode: a LIVE tile at the top of the sidebar playing
 * their stream (no sound), their name at the bottom and a glowing red LIVE
 * (Kaalob's drawing). Clicking it takes you into that videochat with their
 * stream big.
 */
export function LiveTile(props: {
  serverId: string;
  channelId: string;
  /** the streamer: their uid is their name in the call */
  uid: string;
  name: string;
  onOpen: () => void;
}) {
  let video: HTMLVideoElement | undefined;
  const [playing, setPlaying] = createSignal(false);

  onMount(() => {
    let room: Room | undefined;
    let gone = false;
    let retry = 0;
    const attach = (track: RemoteTrack) => {
      if (!video) return;
      track.attach(video);
      setPlaying(true);
    };
    async function connect() {
      try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken || gone) return;
        const res = await fetch("/api/dh-token", {
          method: "POST",
          headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ serverId: props.serverId, channelId: props.channelId, peek: PEEK_TAG }),
        });
        const pass = (await res.json()) as { url?: string; token?: string };
        if (!res.ok || !pass.url || !pass.token || gone) throw new Error("no pass");
        const next = new Room({ adaptiveStream: true });
        next
          .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub, participant) => {
            if (participant.identity === props.uid && pub.trackName === "stream" && track.kind === Track.Kind.Video) attach(track);
          })
          .on(RoomEvent.TrackUnsubscribed, (_track, pub, participant) => {
            if (participant.identity === props.uid && pub.trackName === "stream") setPlaying(false);
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
    void connect();
    onCleanup(() => {
      gone = true;
      window.clearTimeout(retry);
      void room?.disconnect();
    });
  });

  return (
    <button type="button" class="room-tile live-tile" title={`${props.name} is live`} onClick={props.onOpen}>
      <video ref={video} autoplay playsinline muted classList={{ hidden: !playing() }} />
      <Show when={!playing()}>
        <span class="live-tile-wait" />
      </Show>
      <span class="live-badge">LIVE</span>
      <span class="room-tile-name">{props.name}</span>
    </button>
  );
}
