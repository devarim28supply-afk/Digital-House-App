import { Room, RoomEvent, Track, type RemoteTrack, type RemoteTrackPublication, type RemoteParticipant } from "livekit-client";
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";

import { audit } from "../data/audit";
import { auth } from "../firebase";
import { type Profile, displayName } from "../data/store";

/*
 * Watch one live call from the Dashboard: a hidden, subscribe-only LiveKit
 * connection (api/dh-rooms.ts's "watch" action — the same hidden/
 * canPublish:false grant shape api/dh-token.ts already uses for the 3D
 * room's wall and a LIVE tile's peek), so nobody in the call is told staff
 * is watching. adaptiveStream stays on: unlike the wall (an off-screen 3D
 * page), this tile is always actually visible while open, so LiveKit's
 * visibility-based quality adjustment helps rather than blacking out video.
 */

export function LiveCallWatch(props: { room: string; serverId: string; serverName: string; profiles: Map<string, Profile>; onClose: () => void }) {
  const [tracks, setTracks] = createSignal(new Map<string, { track: RemoteTrack; identity: string }>());
  const [error, setError] = createSignal("");
  const [connecting, setConnecting] = createSignal(true);
  let audioHost: HTMLDivElement | undefined;
  let gone = false;
  let room: Room | undefined;

  const trackKey = (p: RemoteParticipant, pub: RemoteTrackPublication) => `${p.identity}:${pub.trackSid}`;

  onMount(() => {
    audioHost = document.createElement("div");
    audioHost.hidden = true;
    document.body.appendChild(audioHost);

    // serverId here is the real Firestore server, never the LiveKit room's
    // own name - that one is only ever this call's own identity, and
    // writing it as serverId instead would make this entry impossible to
    // attribute to a server afterward (it never matches one).
    audit("call.watch", { serverId: props.serverId, target: props.serverName });

    void (async () => {
      try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken) throw new Error("Log in first.");
        const res = await fetch("/api/dh-rooms", {
          method: "POST",
          headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "watch", room: props.room }),
        });
        const body = (await res.json().catch(() => ({}))) as { url?: string; token?: string; error?: string };
        if (!res.ok || !body.url || !body.token) throw new Error(body.error || "Could not watch this call.");
        if (gone) return;

        const next = new Room({ adaptiveStream: true, dynacast: true });
        next
          .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
            if (track.kind === Track.Kind.Audio) {
              const el = track.attach();
              el.muted = false;
              audioHost?.appendChild(el);
            }
            setTracks((prev) => {
              const map = new Map(prev);
              map.set(trackKey(participant, pub), { track, identity: participant.identity });
              return map;
            });
          })
          .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
            track.detach().forEach((el) => el.remove());
            setTracks((prev) => {
              const map = new Map(prev);
              map.delete(trackKey(participant, pub));
              return map;
            });
          })
          .on(RoomEvent.Disconnected, () => {
            if (!gone) setError("The call ended.");
          });

        await next.connect(body.url, body.token);
        if (gone) {
          await next.disconnect();
          return;
        }
        room = next;
        setConnecting(false);
      } catch (err) {
        if (!gone) {
          setError(err instanceof Error ? err.message : "Could not watch this call.");
          setConnecting(false);
        }
      }
    })();
  });

  onCleanup(() => {
    gone = true;
    void room?.disconnect();
    audioHost?.remove();
  });

  const videoTracks = () => [...tracks().entries()].filter(([, v]) => v.track.kind === Track.Kind.Video);
  // a real call participant's identity is their plain uid (same as any
  // normal join - see api/dh-token.ts's issue()), so the usual profile
  // lookup resolves their name exactly like everywhere else in the app
  const nameOf = (identity: string) => displayName(props.profiles.get(identity), identity);

  return (
    <div class="dashboard-watch">
      <div class="dashboard-watch-head">
        <span>Monitoring {props.serverName} — read-only</span>
        <button class="btn" type="button" onClick={props.onClose}>
          Close
        </button>
      </div>
      <Show when={error()}>
        <p class="roles-error" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={connecting() && !error()}>
        <p class="modal-text">Connecting…</p>
      </Show>
      <div class="dashboard-watch-grid">
        <For each={videoTracks()} fallback={<Show when={!connecting() && !error()}><p class="modal-text">Nobody has their camera on.</p></Show>}>
          {([, v]) => <WatchVideo track={v.track} label={nameOf(v.identity)} />}
        </For>
      </div>
    </div>
  );
}

function WatchVideo(props: { track: RemoteTrack; label: string }) {
  let video: HTMLVideoElement | undefined;
  createEffect(() => {
    const el = video;
    if (!el) return;
    props.track.attach(el);
    onCleanup(() => props.track.detach(el));
  });
  return (
    <div class="dashboard-watch-tile">
      <video ref={video} autoplay playsinline muted />
      <span class="dashboard-watch-label">{props.label}</span>
    </div>
  );
}
