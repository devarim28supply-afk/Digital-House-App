import { createSignal } from "solid-js";

/**
 * Where you are in the app, for the Online list: the call you joined and
 * the room you are looking at (a tile's Room view). The Shell turns these
 * into your presence's "where".
 */
const [inCall, setInCall] = createSignal<string | undefined>();
const [inRoom, setInRoom] = createSignal<string | undefined>();

export { inCall, inRoom, setInCall, setInRoom };

export function whereNow() {
  const room = inRoom();
  if (room) return `In ${room}`;
  const call = inCall();
  if (call) return `Videochat · ${call}`;
  return "";
}
