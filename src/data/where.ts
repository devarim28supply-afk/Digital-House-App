import { createSignal } from "solid-js";

/**
 * Where you are in the app, for the Online list: the call you joined and
 * the room you are looking at (a tile's Room view). The Shell turns these
 * into your presence's "where".
 */
const [inCall, setInCall] = createSignal<string | undefined>();
const [inRoom, setInRoom] = createSignal<string | undefined>();

export { inCall, inRoom, setInCall, setInRoom };

/** Where you are streaming right now (stream mode), for your presence. */
const [streamingIn, setStreamingIn] = createSignal<{ serverId: string; channelId: string; team?: string } | undefined>();
export { setStreamingIn, streamingIn };

/** A LIVE tile was clicked: show this person's stream big once the call is up. */
const [watchRequest, setWatchRequest] = createSignal<string | undefined>();
export { setWatchRequest, watchRequest };

export function whereNow() {
  const room = inRoom();
  if (room) return `In ${room}`;
  const call = inCall();
  if (call) return `Videochat · ${call}`;
  return "";
}
