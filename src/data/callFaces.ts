import { createSignal } from "solid-js";

/** One videochat webcam, as the call currently has it. No stream: camera off. */
export type CallFace = { identity: string; name: string; video?: MediaStream };

/**
 * The open videochat's webcams, kept by VoiceRoom so a big TV can show the
 * same row underneath. Empty when you are not in that call.
 */
const [callFaces, setCallFaces] = createSignal<{ channelKey: string; callers: CallFace[] } | undefined>();

export { callFaces, setCallFaces };
