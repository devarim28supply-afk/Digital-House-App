import { Match, Switch, createResource, createSignal, onCleanup, onMount } from "solid-js";

import { type Room, Track } from "livekit-client";

import { findRoomTile, watchProfiles } from "../data/store";
import type { Profile } from "../data/store";
import { VoiceRoom } from "./VoiceRoom";

import "./app.css";

// The Gestr rooms that hang this page on a wall (?wall=living). Live they are
// on this same address; on this PC the room's own dev server.
const ROOM_ORIGINS = new Set([location.origin, "http://localhost:5176", "http://127.0.0.1:5176"]);

/**
 * The Living Room tile's video chat, chromeless, for the wall in the 3D
 * Living Room. Joins by itself with the mic off. The room already has your
 * camera open for its diamond face plate; it sends those frames here, and
 * they are published as your camera, so the device is never opened twice.
 * Esc gives the cursor back to the room.
 */
export function WallView(props: { uid: string; name: string; roomKey: string }) {
  const [tile] = createResource(() => findRoomTile(props.uid, props.roomKey));
  const [profiles, setProfiles] = createSignal(new Map<string, Profile>());
  const [diamondOn, setDiamondOn] = createSignal(false);
  let room: Room | undefined;
  let published: MediaStreamTrack | undefined;
  let publishing = false;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  function parentOrigin() {
    const ancestor = location.ancestorOrigins?.[0];
    return ancestor && ROOM_ORIGINS.has(ancestor) ? ancestor : location.origin;
  }

  async function publishDiamond() {
    if (published || publishing || !room || room.state !== "connected") return;
    const track = canvas.captureStream(15).getVideoTracks()[0];
    if (!track) return;
    publishing = true;
    try {
      await room.localParticipant.publishTrack(track, { source: Track.Source.Camera, name: "diamond", simulcast: false });
      published = track;
    } catch {
      track.stop();
    } finally {
      publishing = false;
    }
  }

  async function clearDiamond() {
    setDiamondOn(false);
    const track = published;
    published = undefined;
    if (!track) return;
    try {
      await room?.localParticipant.unpublishTrack(track, true);
    } catch {
      track.stop();
    }
  }

  function draw(bitmap: ImageBitmap) {
    if (!ctx) return bitmap.close();
    const scale = Math.min(1, 960 / Math.max(bitmap.width, bitmap.height, 1));
    const w = Math.max(2, Math.round(bitmap.width * scale));
    const h = Math.max(2, Math.round(bitmap.height * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    setDiamondOn(true);
    void publishDiamond();
  }

  onMount(() => {
    const onMessage = (event: MessageEvent) => {
      if (!ROOM_ORIGINS.has(event.origin) || event.source !== window.parent) return;
      if (event.data?.type === "dh-diamond-frame" && event.data.bitmap) draw(event.data.bitmap as ImageBitmap);
      if (event.data?.type === "dh-diamond-cam" && event.data.on === false) void clearDiamond();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") window.parent.postMessage({ type: "dh-wall-release" }, parentOrigin());
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKey);
    const stopProfiles = watchProfiles(setProfiles);
    onCleanup(() => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKey);
      stopProfiles();
      void clearDiamond();
    });
  });

  return (
    <main class="wall">
      <Switch>
        <Match when={tile.loading}>
          <p class="wall-note">Opening the Living Room…</p>
        </Match>
        <Match when={tile()}>
          {(found) => (
            <VoiceRoom
              serverId={found().serverId}
              channel={found().channel}
              uid={props.uid}
              name={props.name}
              profiles={profiles()}
              autoJoin
              onRoom={(next) => {
                room = next;
                if (next && diamondOn()) void publishDiamond();
                if (!next) published = undefined;
              }}
              camera={{
                on: diamondOn(),
                // the room owns the camera: ask it to switch its diamond on/off
                toggle: () => window.parent.postMessage({ type: "dh-diamond-toggle" }, parentOrigin()),
              }}
            />
          )}
        </Match>
        <Match when={true}>
          <p class="wall-note">No Living Room tile in your servers yet.</p>
        </Match>
      </Switch>
    </main>
  );
}
