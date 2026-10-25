import { type Unsubscribe, collection, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, writeBatch } from "firebase/firestore";

import { db } from "../firebase";
import type { Server } from "./store";

/*
 * Direct messages, like Discord's: a private conversation between two
 * people. A DM is a small server only the two of them are in, marked
 * kind "dm", so the server rules keep it private (only its members read it)
 * and the chat, files, reactions and videochat all work as they do in a
 * server:
 *
 *   servers/dm_<uidA>_<uidB>   kind "dm", name "DM", ownerUid (who started
 *                               it), memberUids [both]   (uids sorted)
 *     channels/chat            the conversation (kind "text")
 *     channels/call            its videochat    (kind "voice")
 */

export const DM_CHAT = "chat";
export const DM_CALL = "call";

export const isDm = (s: Server | undefined) => s?.kind === "dm";

/** The one DM between two people always has the same id. */
export const dmIdFor = (a: string, b: string) => `dm_${[a, b].sort().join("_")}`;

/** The other person in a DM. */
export const dmPartner = (s: Server, me: string) => s.memberUids.find((u) => u !== me) ?? me;

/** Start a DM with someone (or find the one there is). Returns its id. */
export async function openDm(me: string, other: string, existing: Server[]): Promise<string> {
  const id = dmIdFor(me, other);
  if (existing.some((s) => s.id === id)) return id;
  const ref = doc(db, "servers", id);
  // the server first: the channel rules look it up
  await setDoc(ref, { name: "DM", kind: "dm", ownerUid: me, memberUids: [me, other].sort(), open: false, createdAt: serverTimestamp() });
  const batch = writeBatch(db);
  batch.set(doc(ref, "channels", DM_CHAT), { name: "chat", kind: "text", position: 0 });
  batch.set(doc(ref, "channels", DM_CALL), { name: "call", kind: "voice", position: 1 });
  await batch.commit();
  return id;
}

/** The newest message in a DM (when, and who wrote it), for unread dots and order. */
export function watchLatest(dmId: string, cb: (latest: { at: number; author: string } | null) => void): Unsubscribe {
  const q = query(collection(db, "servers", dmId, "channels", DM_CHAT, "messages"), orderBy("createdAt", "desc"), limit(1));
  return onSnapshot(
    q,
    (snap) => {
      const d = snap.docs[0]?.data();
      cb(d ? { at: d.createdAt?.toMillis?.() ?? Date.now(), author: String(d.authorUid ?? "") } : null);
    },
    () => cb(null),
  );
}

// When you last read each DM, on this device.
const READ_KEY = "dh_dm_read";
export function readTimes(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(READ_KEY) || "{}");
  } catch {
    return {};
  }
}
export function markRead(dmId: string, at = Date.now()) {
  const all = readTimes();
  all[dmId] = Math.max(all[dmId] ?? 0, at);
  try {
    localStorage.setItem(READ_KEY, JSON.stringify(all));
  } catch {
    /* private mode */
  }
}
