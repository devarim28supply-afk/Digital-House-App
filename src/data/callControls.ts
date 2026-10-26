import { createSignal } from "solid-js";
import { RoomEvent, type Room } from "livekit-client";

const [activeCall, setActiveCall] = createSignal<Room>();
const [microphoneEnabled, setMicrophoneEnabled] = createSignal(false);
const [deafened, setDeafened] = createSignal(false);
const [audioBusy, setAudioBusy] = createSignal(false);
const [audioError, setAudioError] = createSignal("");
export { activeCall, microphoneEnabled, deafened, audioBusy, audioError };
let restoreMicrophone = false;

/** The live VoiceRoom owns the binding; old cleanup cannot clear a newer call. */
export function bindCallControls(room: Room) {
  setActiveCall(room);
  const refresh = () => {
    if (activeCall() === room) setMicrophoneEnabled(room.localParticipant.isMicrophoneEnabled);
  };
  const events = [RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted];
  for (const event of events) room.on(event, refresh);
  refresh();
  return () => {
    for (const event of events) room.off(event, refresh);
    if (activeCall() === room) {
      setActiveCall(undefined); setMicrophoneEnabled(false); restoreMicrophone = false; setAudioError("");
    }
  };
}

async function audioAction(action: () => Promise<void>) {
  if (audioBusy()) return;
  setAudioBusy(true); setAudioError("");
  try { await action(); }
  catch (error) { setAudioError(error instanceof Error ? error.message : "Could not change your call audio."); }
  finally {
    setMicrophoneEnabled(activeCall()?.localParticipant.isMicrophoneEnabled ?? false);
    setAudioBusy(false);
  }
}
export function toggleMicrophone() {
  return audioAction(async () => {
    const room = activeCall();
    if (!room) return;
    const enable = !room.localParticipant.isMicrophoneEnabled;
    if (enable && deafened()) { setDeafened(false); restoreMicrophone = false; }
    await room.localParticipant.setMicrophoneEnabled(enable);
  });
}
export function toggleDeafen() {
  return audioAction(async () => {
    const room = activeCall();
    if (!deafened()) {
      const wasEnabled = room?.localParticipant.isMicrophoneEnabled ?? false;
      if (wasEnabled) await room!.localParticipant.setMicrophoneEnabled(false);
      restoreMicrophone = wasEnabled;
      setDeafened(true);
    } else {
      setDeafened(false);
      const restore = restoreMicrophone;
      restoreMicrophone = false;
      if (room && restore) await room.localParticipant.setMicrophoneEnabled(true);
    }
  });
}
