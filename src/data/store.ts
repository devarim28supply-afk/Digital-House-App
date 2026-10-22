import {
  type Timestamp,
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";

import { db } from "../firebase";

/*
 * Firestore layout (rules: M2A-Access-Control/firestore.rules):
 *
 *   profiles/{uid}       name, username, color          everyone approved reads
 *   presence/{uid}       lastSeen                         heartbeat, self-written
 *   servers/{sid}        name, ownerUid, memberUids[]     only its members read
 *     channels/{cid}     name, kind "text"|"voice"|"room", position
 *                        room: image, and roomKey (a Gestr room) or url
 *       messages/{mid}   authorUid, text, createdAt, editedAt?
 */

export type Profile = { uid: string; name: string; username: string; color: string };
export type Server = { id: string; name: string; ownerUid: string; memberUids: string[] };
/**
 * "room" is a picture tile: click it for the room's video chat, and a toggle
 * flips the same pane to the room page itself (a Gestr 3D room or any link).
 */
export type Channel = {
  id: string;
  name: string;
  kind: "text" | "voice" | "room";
  position: number;
  image?: string;
  roomKey?: string;
  url?: string;
};

// Gestr rooms a tile can point at: the local dev server on this PC, the
// live page everywhere else.
const GESTR_ROOMS: Record<string, { local: string; live: string }> = {
  "gestr-living": { local: "http://127.0.0.1:5176/", live: "https://gestr-lab.vercel.app/living/" },
};

export function roomUrlOf(channel: Channel) {
  const room = channel.roomKey ? GESTR_ROOMS[channel.roomKey] : undefined;
  if (room) return /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? room.local : room.live;
  return channel.url ?? "";
}

export const LIVING_TILE: Omit<Channel, "id" | "position"> = {
  name: "Living",
  kind: "room",
  image: "/living.png",
  roomKey: "gestr-living",
};
export type Message = {
  id: string;
  authorUid: string;
  text: string;
  createdAt: Date | null;
  editedAt: Date | null;
};

type Unsubscribe = () => void;

const PALETTE = ["#4ADE80", "#60A5FA", "#F472B6", "#FBBF24", "#A78BFA", "#2DD4BF", "#F87171", "#FB923C"];

function colorFor(uid: string) {
  let h = 0;
  for (const c of uid) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const toDate = (t: unknown) => ((t as Timestamp | null)?.toDate?.() ?? null);

// ---- profiles ---------------------------------------------------------------

/** Keep your public face in step with your member record. */
export async function saveProfile(uid: string, name: string, username: string) {
  await setDoc(doc(db, "profiles", uid), { uid, name, username, color: colorFor(uid) }, { merge: true });
}

export function watchProfiles(cb: (profiles: Map<string, Profile>) => void): Unsubscribe {
  return onSnapshot(collection(db, "profiles"), (snap) => {
    cb(new Map(snap.docs.map((d) => [d.id, { uid: d.id, ...(d.data() as Omit<Profile, "uid">) }])));
  });
}

// ---- presence ---------------------------------------------------------------

const HEARTBEAT_MS = 45_000;
export const ONLINE_WINDOW_MS = 2 * 60_000;

/** Write a heartbeat now and every 45 s while the page is open. */
export function startPresence(uid: string): Unsubscribe {
  const beat = () => setDoc(doc(db, "presence", uid), { lastSeen: serverTimestamp() }).catch(() => {});
  beat();
  const timer = window.setInterval(beat, HEARTBEAT_MS);
  const onVisible = () => document.visibilityState === "visible" && beat();
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

export function watchPresence(cb: (lastSeen: Map<string, number>) => void): Unsubscribe {
  return onSnapshot(collection(db, "presence"), (snap) => {
    cb(new Map(snap.docs.map((d) => [d.id, toDate(d.data().lastSeen)?.getTime() ?? Date.now()])));
  });
}

// ---- servers ----------------------------------------------------------------

export function watchServers(uid: string, cb: (servers: Server[]) => void): Unsubscribe {
  const q = query(collection(db, "servers"), where("memberUids", "array-contains", uid));
  return onSnapshot(q, (snap) => {
    const servers = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Server, "id">) }));
    servers.sort((a, b) => a.name.localeCompare(b.name));
    cb(servers);
  });
}

/** A new server with a text and a voice channel to start. */
export async function createServer(uid: string, name: string, channels?: Omit<Channel, "id">[]) {
  const ref = doc(collection(db, "servers"));
  // The server first: the channel rules look the server up, and a write in
  // the same batch is not visible to that lookup yet.
  await setDoc(ref, { name, ownerUid: uid, memberUids: [uid], createdAt: serverTimestamp() });
  const batch = writeBatch(db);
  const start = channels ?? [
    { name: "general", kind: "text", position: 0 },
    { name: "Lounge", kind: "voice", position: 1 },
  ];
  for (const ch of start) batch.set(doc(collection(ref, "channels")), ch);
  await batch.commit();
  return ref.id;
}

/** The home server, made once by the operator on first sign-in. */
export async function ensureHomeServer(uid: string) {
  const mine = await getDocs(query(collection(db, "servers"), where("memberUids", "array-contains", uid)));
  if (!mine.empty) return;
  await createServer(uid, "Digital House", [
    { ...LIVING_TILE, position: 0 },
    { name: "general", kind: "text", position: 1 },
    { name: "Lounge", kind: "voice", position: 2 },
  ]);
}

/** A Digital House made before tiles existed gets its Living tile once. */
export async function ensureLivingTile(sid: string, channels: Channel[]) {
  if (channels.some((c) => c.kind === "room" && c.roomKey === LIVING_TILE.roomKey)) return;
  const first = channels.reduce((min, c) => Math.min(min, c.position), 0);
  await addDoc(collection(db, "servers", sid, "channels"), { ...LIVING_TILE, position: first - 1 });
}

export const renameServer = (sid: string, name: string) => updateDoc(doc(db, "servers", sid), { name });
export const addServerMembers = (sid: string, uids: string[]) =>
  updateDoc(doc(db, "servers", sid), { memberUids: arrayUnion(...uids) });
export const removeServerMember = (sid: string, uid: string) =>
  updateDoc(doc(db, "servers", sid), { memberUids: arrayRemove(uid) });

// ---- channels ---------------------------------------------------------------

export function watchChannels(sid: string, cb: (channels: Channel[]) => void): Unsubscribe {
  return onSnapshot(query(collection(db, "servers", sid, "channels"), orderBy("position")), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Channel, "id">) })));
  });
}

export const createChannel = (
  sid: string,
  name: string,
  kind: Channel["kind"],
  position: number,
  extra: { image?: string; url?: string } = {},
) => addDoc(collection(db, "servers", sid, "channels"), { name, kind, position, ...extra });

/** A picked image, shrunk to a tile-sized JPEG so it fits in the channel record. */
export function shrinkImage(file: File, maxWidth = 480): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const src = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      URL.revokeObjectURL(src);
      if (!ctx) return reject(new Error("Could not read that image"));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => {
      URL.revokeObjectURL(src);
      reject(new Error("Could not read that image"));
    };
    img.src = src;
  });
}
export const renameChannel = (sid: string, cid: string, name: string) =>
  updateDoc(doc(db, "servers", sid, "channels", cid), { name });
export const deleteChannel = (sid: string, cid: string) => deleteDoc(doc(db, "servers", sid, "channels", cid));

// ---- messages ---------------------------------------------------------------

const PAGE = 150;

export function watchMessages(sid: string, cid: string, cb: (messages: Message[]) => void): Unsubscribe {
  const q = query(collection(db, "servers", sid, "channels", cid, "messages"), orderBy("createdAt", "desc"), limit(PAGE));
  return onSnapshot(q, (snap) => {
    const rows = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        authorUid: data.authorUid as string,
        text: data.text as string,
        // a message we just sent has no server time yet: show it as now
        createdAt: toDate(data.createdAt) ?? new Date(),
        editedAt: toDate(data.editedAt),
      };
    });
    cb(rows.reverse());
  });
}

export const sendMessage = (sid: string, cid: string, authorUid: string, text: string) =>
  addDoc(collection(db, "servers", sid, "channels", cid, "messages"), {
    authorUid,
    text,
    createdAt: serverTimestamp(),
  });

export const editMessage = (sid: string, cid: string, mid: string, authorUid: string, text: string) =>
  updateDoc(doc(db, "servers", sid, "channels", cid, "messages", mid), {
    authorUid,
    text,
    editedAt: serverTimestamp(),
  });

export const deleteMessage = (sid: string, cid: string, mid: string) =>
  deleteDoc(doc(db, "servers", sid, "channels", cid, "messages", mid));
