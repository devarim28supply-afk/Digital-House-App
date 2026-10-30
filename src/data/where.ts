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

/** You own the open call's server, or you are an admin: the call shows its Remove button. */
const [canRemoveFromCall, setCanRemoveFromCall] = createSignal(false);
export { canRemoveFromCall, setCanRemoveFromCall };

/**
 * Living Room's 3D TV has its own remote (backlight color/opacity, room
 * light on/off) - LivingRoomBroadcast.tsx sets `tvRemoteAvailable` while
 * it's mounted, and owns `tvRemoteOpen`'s actual panel. A plain shared
 * signal (same pattern as inCall/streamingIn above) instead of prop-
 * drilling through RoomPane.tsx, which this needs to reach through
 * without touching.
 */
const [tvRemoteAvailable, setTvRemoteAvailable] = createSignal(false);
const [tvRemoteOpen, setTvRemoteOpen] = createSignal(false);
export { tvRemoteAvailable, setTvRemoteAvailable, tvRemoteOpen, setTvRemoteOpen };

export function whereNow() {
  const room = inRoom();
  if (room) return `In ${room}`;
  const call = inCall();
  if (call) return `Videochat · ${call}`;
  return "";
}
