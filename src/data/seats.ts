import { type LocalParticipant, type Participant, type Room, RoomEvent, Track } from "livekit-client";

/*
 * The Darkwood Room's four desks, handed out by the tile's videochat
 * (Kaalob): whoever joins the call gets the first free desk, first come
 * first served. The fifth and later wait in the middle of the room, and the
 * one waiting longest gets the next desk that frees up.
 *
 * Standing up keeps your desk only while you share your screen (or stream);
 * otherwise it frees. Leaving the call frees it too.
 *
 * Each person says where they are in their own LiveKit attributes, so
 * everyone (and the room page, watching the call) sees the same seats. Two
 * people grabbing one desk at once: the one who joined first keeps it.
 */

export const SEATS = 4;
export const SEAT_ATTR = "dw-seat"; // "0".."3", or "" with no desk
export const WAIT_ATTR = "dw-wait"; // "1": in the middle, waiting for a desk
export const STAND_ATTR = "dw-stand"; // "1": up from the desk, keeping it (sharing)

// the video chat's own track names (VoiceRoom): stream mode, a second screen, the Stream webcam
const SHARE_NAMES = new Set(["stream", "screen-2", "webcam-2"]);

/** A real person in the call (watchers and extras are "uid:...") */
export const isPerson = (p: Participant) => !p.identity.includes(":");

export function seatOf(p: Participant) {
  const n = Number.parseInt(p.attributes[SEAT_ATTR] ?? "", 10);
  return n >= 0 && n < SEATS ? n : -1;
}

/** Sharing a screen or streaming a game into the call */
export function isSharing(p: Participant) {
  for (const pub of p.trackPublications.values()) {
    if (pub.kind !== Track.Kind.Video || pub.isMuted) continue;
    if (pub.source === Track.Source.ScreenShare || SHARE_NAMES.has(pub.trackName)) return true;
  }
  return false;
}

const joined = (p: Participant) => p.joinedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
/** who came first (the earlier join wins a desk) */
const before = (a: Participant, b: Participant) => joined(a) - joined(b) || (a.identity < b.identity ? -1 : 1);

export type SeatControl = {
  /** sat down at desk `seat` in the room (when it is free) */
  sit: (seat: number) => void;
  /** got up from the desk in the room */
  stand: () => void;
  stop: () => void;
};

export function startSeats(room: Room): SeatControl {
  const me: LocalParticipant = room.localParticipant;
  let seat = -1;
  let waiting = true; // new in the call: wants a desk
  let standing = false;
  let sent = "";

  function holders() {
    const held = new Map<number, Participant>();
    for (const p of room.remoteParticipants.values()) {
      if (!isPerson(p)) continue;
      const s = seatOf(p);
      const h = held.get(s);
      if (s >= 0 && (!h || before(p, h) < 0)) held.set(s, p);
    }
    return held;
  }

  function reconcile() {
    if (room.state !== "connected") return;
    const held = holders();
    // someone who came first holds my desk too: back to waiting
    const other = seat >= 0 ? held.get(seat) : undefined;
    if (other && before(other, me) < 0) {
      seat = -1;
      waiting = true;
      standing = false;
    }
    // up from the desk and not sharing: the desk is free for the next person
    if (seat >= 0 && standing && !isSharing(me)) {
      seat = -1;
      waiting = false;
      standing = false;
    }
    if (seat < 0 && waiting) {
      const free = [...Array(SEATS).keys()].filter((i) => !held.has(i));
      const waiters = [me, ...[...room.remoteParticipants.values()].filter((p) => isPerson(p) && seatOf(p) < 0 && p.attributes[WAIT_ATTR] === "1")];
      waiters.sort(before);
      // the one waiting longest takes the first free desk; the next one
      // takes another when this one's attributes arrive
      if (free.length && waiters[0] === me) {
        seat = free[0];
        waiting = false;
      }
    }
    publish();
  }

  function publish() {
    const attrs = {
      [SEAT_ATTR]: seat >= 0 ? String(seat) : "",
      [WAIT_ATTR]: waiting ? "1" : "",
      [STAND_ATTR]: seat >= 0 && standing ? "1" : "",
    };
    const key = JSON.stringify(attrs);
    if (key === sent) return;
    sent = key;
    me.setAttributes(attrs).catch((err) => {
      sent = "";
      console.warn("[seats] could not say where you sit:", err);
    });
  }

  const events = [
    RoomEvent.ParticipantConnected,
    RoomEvent.ParticipantDisconnected,
    RoomEvent.ParticipantAttributesChanged,
    RoomEvent.LocalTrackPublished,
    RoomEvent.LocalTrackUnpublished,
    RoomEvent.TrackMuted,
    RoomEvent.TrackUnmuted,
  ] as const;
  for (const e of events) room.on(e, reconcile);
  const timer = window.setInterval(reconcile, 3000);
  reconcile();

  return {
    sit(next) {
      if (next === seat) {
        standing = false;
      } else if (next >= 0 && next < SEATS && !holders().has(next)) {
        seat = next;
        waiting = false;
        standing = false;
      }
      reconcile();
    },
    stand() {
      if (seat >= 0) standing = true;
      reconcile();
    },
    stop() {
      window.clearInterval(timer);
      for (const e of events) room.off(e, reconcile);
    },
  };
}
