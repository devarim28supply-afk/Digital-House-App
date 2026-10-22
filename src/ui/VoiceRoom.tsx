import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";

import {
  type Participant,
  type RemoteTrack,
  Room,
  RoomEvent,
  Track,
  type TrackPublication,
} from "livekit-client";

import { type Channel, type Profile } from "../data/store";
import { auth } from "../firebase";
import { initials } from "./Shell";

/** A pass for this channel's LiveKit room, checked against Firestore. */
async function fetchPass(serverId: string, channelId: string) {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error("Log in first.");
  const res = await fetch("/api/dh-token", {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, channelId }),
  });
  const body = (await res.json().catch(() => ({}))) as { url?: string; token?: string; error?: string };
  if (!res.ok || !body.url || !body.token) throw new Error(body.error || "Could not join the call.");
  return { url: body.url, token: body.token };
}

type TileInfo = {
  key: string;
  participant: Participant;
  publication?: TrackPublication;
  screen: boolean;
};

/**
 * A voice/video channel. Nothing turns on by itself: Join connects, and the
 * mic and camera start off until you switch them on.
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
}) {
  const [room, setRoom] = createSignal<Room | undefined>();
  const [joining, setJoining] = createSignal(false);
  const [error, setError] = createSignal("");
  const [version, setVersion] = createSignal(0);
  const [speaking, setSpeaking] = createSignal(new Set<string>());
  const bump = () => setVersion((v) => v + 1);
  const audioHost = document.createElement("div");
  audioHost.hidden = true;
  document.body.appendChild(audioHost);

  createEffect(() => props.onRoom?.(room()));

  function leave() {
    const current = room();
    setRoom(undefined);
    current?.disconnect();
    audioHost.replaceChildren();
    setSpeaking(new Set<string>());
  }

  // Leaving the channel (or switching away) hangs up.
  createEffect(on(() => [props.serverId, props.channel.id], () => leave(), { defer: true }));
  onCleanup(() => {
    leave();
    audioHost.remove();
  });

  async function join() {
    setError("");
    setJoining(true);
    try {
      const pass = await fetchPass(props.serverId, props.channel.id);
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

  async function toggle(kind: "mic" | "cam" | "screen") {
    const me = room()?.localParticipant;
    if (!me) return;
    setError("");
    try {
      if (kind === "mic") await me.setMicrophoneEnabled(!me.isMicrophoneEnabled);
      if (kind === "cam") await me.setCameraEnabled(!me.isCameraEnabled);
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
    const people: Participant[] = [current.localParticipant, ...current.remoteParticipants.values()];
    const screens: TileInfo[] = [];
    const cams: TileInfo[] = [];
    for (const p of people) {
      const screen = p.getTrackPublication(Track.Source.ScreenShare);
      if (screen && !screen.isMuted) screens.push({ key: `${p.identity}:screen`, participant: p, publication: screen, screen: true });
      cams.push({ key: `${p.identity}:cam`, participant: p, publication: p.getTrackPublication(Track.Source.Camera), screen: false });
    }
    return [...screens, ...cams];
  });

  const nameOf = (p: Participant) => props.profiles.get(p.identity)?.name || p.name || "Member";

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
        <div class="tiles" data-count={Math.min(tiles().length, 9)}>
          <For each={tiles()}>
            {(tile) => (
              <Tile
                tile={tile}
                version={version()}
                name={tile.screen ? `${nameOf(tile.participant)}'s screen` : nameOf(tile.participant)}
                color={props.profiles.get(tile.participant.identity)?.color ?? "#404040"}
                speaking={!tile.screen && speaking().has(tile.participant.identity)}
              />
            )}
          </For>
        </div>
        <Show when={error()}>
          <p class="form-error voice-error">{error()}</p>
        </Show>
        <div class="dock">
          <button type="button" class="dock-btn" aria-pressed={micOn()} onClick={() => void toggle("mic")}>
            {micOn() ? "Mic on" : "Mic off"}
          </button>
          <Show
            when={props.camera}
            fallback={
              <button type="button" class="dock-btn" aria-pressed={camOn()} onClick={() => void toggle("cam")}>
                {camOn() ? "Camera on" : "Camera off"}
              </button>
            }
          >
            {(cam) => (
              <button type="button" class="dock-btn" aria-pressed={cam().on} onClick={() => cam().toggle()}>
                {cam().on ? "Camera on" : "Camera off"}
              </button>
            )}
          </Show>
          <button type="button" class="dock-btn" aria-pressed={screenOn()} onClick={() => void toggle("screen")}>
            {screenOn() ? "Sharing" : "Share screen"}
          </button>
          <button type="button" class="dock-btn leave" onClick={leave}>
            Leave
          </button>
        </div>
      </Show>
    </div>
  );
}

function Tile(props: { tile: TileInfo; version: number; name: string; color: string; speaking: boolean }) {
  let video: HTMLVideoElement | undefined;
  const track = () => {
    void props.version;
    const pub = props.tile.publication;
    return pub && !pub.isMuted ? pub.track : undefined;
  };

  createEffect(() => {
    const t = track();
    if (!t || !video) return;
    t.attach(video);
    onCleanup(() => t.detach(video!));
  });

  const mirrored = () => props.tile.participant.isLocal && !props.tile.screen;

  return (
    <article class="tile" classList={{ speaking: props.speaking, screen: props.tile.screen }}>
      <video ref={video} autoplay playsinline muted classList={{ hidden: !track(), mirror: mirrored() }} />
      <Show when={!track()}>
        <div class="tile-empty">
          <span class="avatar big" style={{ background: props.color }}>
            {initials(props.name)}
          </span>
        </div>
      </Show>
      <span class="tile-name">{props.name}</span>
    </article>
  );
}
