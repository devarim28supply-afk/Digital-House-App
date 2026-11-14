import { createSignal } from "solid-js";

import type { Track } from "livekit-client";

/**
 * OBS on the sidebar TV (Kaalob): anyone in a channel's videochat can put
 * their OBS picture on the TV screen in the right sidebar, for everyone in
 * that videochat. While it is on it takes over everyone's sidebar TV; when it
 * stops, each TV goes back to the channel it had.
 *
 * The picture travels through the call (VoiceRoom publishes OBS's Virtual
 * Camera on its own named track, "tv-obs"), and the TV is drawn somewhere
 * else (SideTv, in the sidebar), so the two meet here: plain shared signals,
 * the same way callFaces.ts hands the call's webcams to other parts.
 */

/**
 * The OBS picture on the TV right now. by: whose it is. mine: it is yours.
 * audio: its sound (OBS's own, sent with the picture automatically when the
 * person's computer has the virtual cable set up); theirs to hear, never
 * your own, which you already hear from your computer. sound: it has sound.
 */
export type TvObs = { channelKey: string; track: Track; by: string; mine: boolean; audio?: Track; sound: boolean };

/** Set by the call while someone's OBS is on its TV; undefined otherwise. */
const [tvObs, setTvObs] = createSignal<TvObs | undefined>();
export { setTvObs, tvObs };

/** The call you are connected to ("<server>/<channel>"), or "": OBS can only go on from inside it. */
const [tvObsCall, setTvObsCall] = createSignal("");
export { setTvObsCall, tvObsCall };

/** Your OBS is being started (the camera is opening). */
const [tvObsBusy, setTvObsBusy] = createSignal(false);
export { setTvObsBusy, tvObsBusy };

/** The TV's OBS button was pressed: the call for that channel starts or stops your OBS. */
const [tvObsAsk, setTvObsAsk] = createSignal<{ channelKey: string; n: number } | undefined>();
export { tvObsAsk };
export const askTvObs = (channelKey: string) => setTvObsAsk({ channelKey, n: Date.now() });

/**
 * The sidebar TV's channel is the same for everyone (Kaalob: they see what I
 * see). Whoever picks a channel, or turns the TV off, does it for everyone in
 * that channel's videochat. The call carries it (VoiceRoom: each person's
 * LiveKit attribute "dh-tv" holds the newest choice, so it is still there for
 * someone who joins later and outlives the person who made it); the TV reads
 * it here. off: the TV was turned off for everyone.
 */
export type TvShared = { channelKey: string; name: string; url: string; off: boolean; at: number };
const [tvShared, setTvShared] = createSignal<TvShared | undefined>();
export { setTvShared, tvShared };

/** A channel was picked on the TV (null: turned off): the call tells everyone. */
const [tvSharedAsk, setTvSharedAsk] = createSignal<{ channelKey: string; pick: { name: string; url: string } | null; n: number } | undefined>();
export { tvSharedAsk };
export const askTvShared = (channelKey: string, pick: { name: string; url: string } | null) => setTvSharedAsk({ channelKey, pick, n: Date.now() });
