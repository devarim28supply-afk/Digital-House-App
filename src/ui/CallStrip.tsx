import { DeveloperBadge } from "./DeveloperBadge";
import { Index, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";

import { type RemoteParticipant, Room, RoomEvent, Track } from "livekit-client";

import { displayName, type Profile } from "../data/store";
import { fetchPass } from "./VoiceRoom";

type Caller = { identity: string; name: string; video?: MediaStream };

/**
 * The tile's videochat as small screens over the bottom of its Room side,
 * like the Darkwood Room does on its own page (room.html): up to 4 in a row,
 * the rest in a column on the right. Each screen is black with the
 * username in the middle while that camera is off.
 *
 * It watches the call with the hidden, watch-only wall pass, so nobody sees
 * an extra person in the call.
 */
export function CallStrip(props: { serverId: string; channelId: string; profiles: Map<string, Profile> }) {
  const [callers, setCallers] = createSignal<Caller[]>([]);
  const room = new Room({ adaptiveStream: false, dynacast: false });

  // a person's identity is their uid; other names in the call are "uid:..."
  const nameOf = (p: RemoteParticipant) => {
    const prof = props.profiles.get(p.identity.split(":")[0]);
    return displayName(prof, p.name || "someone");
  };
  const refresh = () =>
    setCallers(
      [...room.remoteParticipants.values()].map((p) => {
        const cam = p.getTrackPublication(Track.Source.Camera);
        const live = cam?.track && cam.isSubscribed && !cam.isMuted;
        return { identity: p.identity, name: nameOf(p), video: live ? cam.track!.mediaStream : undefined };
      }),
    );
  // Names can change in Firestore without a LiveKit participant/track event.
  createEffect(() => {
    const profiles = props.profiles;
    setCallers((current) => current.map((caller) => ({
      ...caller,
      name: displayName(profiles.get(caller.identity.split(":")[0]), caller.name),
    })));
  });
  // LiveKit drops a publication just after its events: look again after
  const later = () => setTimeout(refresh);

  onMount(async () => {
    room
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.TrackSubscribed, refresh)
      .on(RoomEvent.TrackUnsubscribed, later)
      .on(RoomEvent.TrackUnpublished, later)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh);
    try {
      const pass = await fetchPass(props.serverId, props.channelId, true);
      await room.connect(pass.url, pass.token);
      refresh();
    } catch (err) {
      console.warn("[call strip] could not show the videochat:", err);
    }
  });
  onCleanup(() => void room.disconnect());

  const row = () => callers().slice(0, 4);
  const side = () => callers().slice(4);
  // Index keeps each screen (and its video) in place while the list is
  // rebuilt, so a refresh never flashes anyone's webcam black.
  const tile = (c: () => Caller) => {
    let video: HTMLVideoElement | undefined;
    createEffect(() => {
      const stream = c().video ?? null;
      if (video && video.srcObject !== stream) video.srcObject = stream;
    });
    return (
      <div class="strip-tile" classList={{ live: Boolean(c().video) }}>
        <video autoplay muted playsinline ref={video} />
        <span class="name">{c().name}<DeveloperBadge username={props.profiles.get(c().identity.split(":")[0])?.username} /></span>
        <span class="who">{c().name}<DeveloperBadge username={props.profiles.get(c().identity.split(":")[0])?.username} /></span>
      </div>
    );
  };

  return (
    <>
      <div class="call-strip">
        <Index each={row()}>{tile}</Index>
      </div>
      <Show when={side().length}>
        <div class="call-strip-side">
          <Index each={side()}>{tile}</Index>
        </div>
      </Show>
    </>
  );
}
