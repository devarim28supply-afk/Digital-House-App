import { Match, Switch, createResource, createSignal, onCleanup, onMount } from "solid-js";

import { findRoomTile, watchProfiles } from "../data/store";
import type { Profile } from "../data/store";
import { VoiceRoom } from "./VoiceRoom";

import "./app.css";

// The Gestr rooms that hang this page on a wall (?wall=living). Live they are
// on this same address; on this PC the room's own dev server.
const ROOM_ORIGINS = new Set([location.origin, "http://localhost:5176", "http://127.0.0.1:5176"]);

/**
 * The Living Room tile's video chat on the wall of the 3D Living Room:
 * always showing, nothing to click. It watches the call (an invisible,
 * watch-only connection under its own name, so it never knocks your own
 * Darkwood Node tab out of the same call). Your webcam reaches the call
 * from the room itself: the tile's videochat shows everyone standing in the
 * room. Esc gives the cursor back to the room.
 */
export function WallView(props: { uid: string; name: string; roomKey: string }) {
  const [tile] = createResource(() => findRoomTile(props.uid, props.roomKey));
  const [profiles, setProfiles] = createSignal(new Map<string, Profile>());

  function parentOrigin() {
    const ancestor = location.ancestorOrigins?.[0];
    return ancestor && ROOM_ORIGINS.has(ancestor) ? ancestor : location.origin;
  }

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") window.parent.postMessage({ type: "dh-wall-release" }, parentOrigin());
    };
    window.addEventListener("keydown", onKey);
    const stopProfiles = watchProfiles(setProfiles);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      stopProfiles();
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
              viewOnly
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
