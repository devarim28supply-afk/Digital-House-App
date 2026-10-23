import { Show, createEffect, createSignal, on, onCleanup } from "solid-js";

import { type Channel, type Profile, roomCamOf, roomUrlOf } from "../data/store";
import { setInRoom, watchRequest } from "../data/where";
import { VoiceRoom } from "./VoiceRoom";

type Pane = "video" | "room";
const paneKey = (cid: string) => `dh_pane_${cid}`;

function recallPane(cid: string): Pane {
  try {
    return localStorage.getItem(paneKey(cid)) === "room" ? "room" : "video";
  } catch {
    return "video";
  }
}

/**
 * A picture tile opened: the room's video chat, and a toggle that flips the
 * same pane to the room page. Both stay alive underneath, so looking at the
 * room does not hang up the call and coming back does not reload the room.
 * The tile's room is one fixed room (store GESTR_ROOMS), the same for all.
 */
export function RoomPane(props: {
  serverId: string;
  channel: Channel;
  uid: string;
  name: string;
  username: string;
  profiles: Map<string, Profile>;
  /** teamed-up streamers here: one rotating screen per team */
  teams?: string[][];
  /** Disconnect pressed: the app ends this call (and with it the room) */
  onLeave: () => void;
}) {
  const [pane, setPane] = createSignal<Pane>(recallPane(props.channel.id));
  // The room page loads the first time it is shown, then stays loaded.
  const [roomLoaded, setRoomLoaded] = createSignal(pane() === "room");

  // Looking at the room: the Online list says "In <room>".
  createEffect(() => {
    if (pane() !== "room") return;
    setInRoom(props.channel.name);
    onCleanup(() => setInRoom(undefined));
  });

  createEffect(
    on(
      () => props.channel.id,
      (cid) => {
        const next = recallPane(cid);
        setPane(next);
        setRoomLoaded(next === "room");
      },
      { defer: true },
    ),
  );

  // A LIVE tile was clicked: the stream is in the videochat, so show it.
  createEffect(() => {
    if (watchRequest() && pane() !== "video") show("video");
  });

  function show(next: Pane) {
    setPane(next);
    if (next === "room") setRoomLoaded(true);
    try {
      localStorage.setItem(paneKey(props.channel.id), next);
    } catch {
      /* private mode */
    }
  }

  const url = () => roomUrlOf(props.channel);
  // the 3D room's live camera, as the Room view in this videochat
  const roomView = () => {
    const cam = roomCamOf(props.channel);
    return cam ? { ...cam, username: props.username } : undefined;
  };

  return (
    <div class="room-pane">
      <div class="pane-switch" role="group" aria-label={`${props.channel.name} view`}>
        <div class="pane-switch-track">
          <button type="button" aria-pressed={pane() === "video"} onClick={() => show("video")}>
            Videochat
          </button>
          <button type="button" aria-pressed={pane() === "room"} onClick={() => show("room")} disabled={!url()}>
            Room
          </button>
        </div>
      </div>

      <div class="pane-layer" classList={{ hidden: pane() !== "video" }}>
        <VoiceRoom
          serverId={props.serverId}
          channel={props.channel}
          uid={props.uid}
          name={props.name}
          profiles={props.profiles}
          roomView={roomView()}
          teams={props.teams}
          autoJoin
          onLeave={props.onLeave}
        />
      </div>

      <div class="pane-layer room-layer" classList={{ hidden: pane() !== "room" }}>
        <Show when={roomLoaded() && url()}>
          {(src) => (
            <iframe
              src={src()}
              title={`${props.channel.name} room`}
              allow="camera; microphone; fullscreen; display-capture; autoplay; xr-spatial-tracking"
            />
          )}
        </Show>
      </div>
    </div>
  );
}
