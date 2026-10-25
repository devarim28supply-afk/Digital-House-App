import {
  type Timestamp,
  FieldPath,
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  deleteField,
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
import { type AuditAction, audit } from "./audit";

/** Do it, then note it in the action log (the Activity page). */
function logged<T>(work: Promise<T>, action: AuditAction, info: { serverId?: string; target?: string; detail?: string }) {
  return work.then((result) => {
    audit(action, info);
    return result;
  });
}

/*
 * Firestore layout (rules: M2A-Access-Control/firestore.rules):
 *
 *   profiles/{uid}       name, username, color,          everyone approved reads
 *                        photo, banner, background        your card's pictures
 *   presence/{uid}       lastSeen                         heartbeat, self-written
 *   servers/{sid}        name, ownerUid, memberUids[]     only its members read
 *                        banner? (a picture URL across the top of the channels)
 *     channels/{cid}     name, kind "text"|"voice"|"room", position
 *                        room: image, and roomKey (a Gestr room) or url
 *                        text: parentId = the room tile it is the chat of
 *       messages/{mid}   authorUid, text, createdAt, editedAt?
 */

export type Profile = {
  uid: string;
  name: string;
  username: string;
  color: string;
  /** shown on your videochat tile instead of your name, if you set one */
  callName?: string;
  /** the three pictures on your profile card: uploaded URLs (a GIF keeps moving) */
  photo?: string;
  banner?: string;
  background?: string;
}
/** Which picture on the profile card: the round face, the top strip, the card itself. */
export type ProfilePicture = "photo" | "banner" | "background";

export type Server = {
  id: string;
  name: string;
  ownerUid: string;
  memberUids: string[];
  banner?: string;
  /** everyone who gets in through M2A-access joins it on their own */
  open?: boolean;
  /** "dm": a direct message between two people (data/dms.ts), not a server */
  kind?: "dm";
};
/**
 * "room" is a picture tile: click it for the room's video chat, and a toggle
 * flips the same pane to the room page itself (a Gestr 3D room or any link).
 * A tile has its own text channel (parentId = the tile): listed under the
 * picture, and shown in the right sidebar while the tile is open.
 */
export type Channel = {
  id: string;
  name: string;
  kind: "text" | "voice" | "room";
  position: number;
  image?: string;
  roomKey?: string;
  url?: string;
  parentId?: string;
};

/** The chat channel name for a tile: "Living Room" -> "livingroom-chat". */
export const tileChatName = (tileName: string) =>
  `${tileName.toLowerCase().replace(/[^a-z0-9]+/g, "") || "room"}-chat`;

// Gestr rooms a tile can point at: the local dev server on this PC, the
// live page everywhere else.
// cam: where the room's live camera ("roomcam") is watched from, for the
// Room view in the tile's videochat: the room's own token server (a hidden,
// watch-only pass) and its LiveKit media room. A new Gestr room adds a line.
type GestrRoom = {
  local: string;
  live: string;
  // wide: the Room view spans the call like a shared screen; otherwise it is
  // a normal tile, the same size as the people
  cam: { localToken: string; liveToken: string; room: string; wide: boolean };
};
const GESTR_ROOMS: Record<string, GestrRoom> = {
  // the room's dev server listens on localhost ([::1]), not 127.0.0.1
  // live it is /living/ on this same address, so the Firebase login is shared
  "gestr-living": {
    local: "http://localhost:5176/",
    live: "/living/",
    cam: { localToken: "http://localhost:5176/api/livekit-token", liveToken: "/living/api/livekit-token", room: "gestr-living", wide: false },
  },
  // the booth behind the bunker's one-way glass (M2A-access is / live)
  "m2a-operation": {
    local: "http://localhost:5179/?spawn=operation",
    live: "/?spawn=operation",
    cam: { localToken: "http://localhost:5179/api/livekit-token", liveToken: "/api/livekit-token", room: "m2a-access", wide: true },
  },
};

const ON_THIS_PC = () => /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

/** Where this tile's room camera is watched from, or null for other tiles. */
export function roomCamOf(channel: Channel) {
  const room = channel.roomKey ? GESTR_ROOMS[channel.roomKey] : undefined;
  if (!room) return null;
  return { tokenUrl: ON_THIS_PC() ? room.cam.localToken : room.cam.liveToken, room: room.cam.room, wide: room.cam.wide };
}

/**
 * A tile picture: uploads are data URLs; the built-in ones ("/living.png")
 * are this app's own files, which live under /app/ on the live site.
 */
export function imageSrc(image?: string) {
  if (!image) return "";
  if (image.startsWith("/") && !image.startsWith("//")) return import.meta.env.BASE_URL + image.slice(1);
  return image;
}

/**
 * The tiles whose Room side is the Darkwood Room (room.html, this app's own
 * CSS 3D room where everyone walks around as their webcam). Every other
 * tile opens only its videochat for now: its Room toggle shows greyed out.
 * The older 3D rooms are still listed above (GESTR_ROOMS) but no tile opens
 * them.
 */
const DARKWOOD_ROOM_TILES = new Set(["gestr-living"]);

export const hasDarkwoodRoom = (channel: Channel) => DARKWOOD_ROOM_TILES.has(channel.roomKey ?? "");

/**
 * Link tiles whose Room side is on: their link opens there. Other link tiles
 * (Don't Lie, White Torture) stay videochat only, Room greyed out.
 */
const ROOM_LINK_SITES = new Set(["viperoneone.com"]); // VIPER 11 theater

function linkSite(url?: string) {
  try {
    return new URL(url ?? "").hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The page a tile's Room side shows, or "" when it has none. */
export function roomUrlOf(channel: Channel, serverId: string) {
  if (!channel.roomKey && ROOM_LINK_SITES.has(linkSite(channel.url))) return channel.url!;
  if (!hasDarkwoodRoom(channel)) return "";
  const q = new URLSearchParams({ s: serverId, c: channel.id });
  return `${import.meta.env.BASE_URL}room.html?${q}`;
}

export const LIVING_TILE: Omit<Channel, "id" | "position"> = {
  name: "Living Room",
  kind: "room",
  image: "/living.png",
  roomKey: "gestr-living",
};

/** The booth behind the window in M2A-access: you spawn inside it. */
export const OPERATION_TILE: Omit<Channel, "id" | "position"> = {
  name: "M2A ACCESS Operation Room",
  kind: "room",
  image: "/operation-room.jpg",
  roomKey: "m2a-operation",
};

/** The home server's built-in tiles, top to bottom, each with its own chat. */
const HOME_TILES: { tile: Omit<Channel, "id" | "position">; chat: string }[] = [
  { tile: OPERATION_TILE, chat: "operation-room" },
  { tile: LIVING_TILE, chat: tileChatName(LIVING_TILE.name) }, // #livingroom-chat
];

/** A built-in tile (it is re-made if removed, so it has no delete button). */
export const isBuiltInTile = (c: Channel) => HOME_TILES.some((h) => h.tile.roomKey === c.roomKey);
/** A picture, video or file sent in a chat (stored in Vercel Blob). */
export type ChatFile = { url: string; name: string; type: string; size: number };

export type Message = {
  id: string;
  authorUid: string;
  text: string;
  files: ChatFile[];
  sticker?: Sticker;
  /** emoji (or :name: for a server emoji) -> who reacted with it */
  reactions: Record<string, string[]>;
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

/** One picture on your card, or null to give that spot back its colour. */
export async function saveProfilePicture(uid: string, field: ProfilePicture, url: string | null) {
  await setDoc(doc(db, "profiles", uid), { [field]: url ?? deleteField() }, { merge: true });
}

/** The name on your videochat tile; empty goes back to your normal name. */
export async function saveCallName(uid: string, callName: string) {
  const clean = callName.trim().slice(0, 40);
  await setDoc(doc(db, "profiles", uid), { callName: clean || deleteField() }, { merge: true });
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
/**
 * Who is online and where. presence/{uid}: lastSeen (heartbeat), and where
 * ("In Living Room", "Videochat · Living Room") with whereAt; the 3D rooms
 * write "In <room>" for whoever stands in them (room-presence.js). A where
 * older than ONLINE_WINDOW_MS has expired (they left that place).
 */
/** Where someone is streaming (stream mode), shown as a LIVE tile to the server. */
/**
 * Where someone is streaming (stream mode), shown as a LIVE tile to the
 * server. team: the streamer they teamed up with (one LIVE tile for the team,
 * rotating between them every 10 s).
 */
export type Streaming = { serverId: string; channelId: string; team?: string };
export type Presence = { lastSeen: number; where: string; whereAt: number; streaming?: Streaming };

/** Heartbeat for this app; setWhere("") when you are not in a call or room. */
export function startPresence(uid: string) {
  let where = "";
  const ref = doc(db, "presence", uid);
  // With a place, say where; without one, only the heartbeat (merge), so a
  // 3D room tab of yours can still report that you stand in it.
  const beat = () =>
    setDoc(ref, where ? { lastSeen: serverTimestamp(), where, whereAt: serverTimestamp() } : { lastSeen: serverTimestamp() }, {
      merge: true,
    }).catch(() => {});
  beat();
  const timer = window.setInterval(beat, HEARTBEAT_MS);
  const onVisible = () => document.visibilityState === "visible" && beat();
  document.addEventListener("visibilitychange", onVisible);
  return {
    setWhere(next: string) {
      if (next === where) return;
      where = next;
      beat();
    },
    /** In stream mode: everyone in that server sees a LIVE tile. null when it ends. */
    setStreaming(streaming: Streaming | null) {
      // merge would keep an old "team" inside; leaving a team must remove it
      const value = streaming ? { ...streaming, team: streaming.team ?? deleteField() } : deleteField();
      void setDoc(ref, { streaming: value, lastSeen: serverTimestamp() }, { merge: true }).catch(() => {});
    },
    stop() {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}

export function watchPresence(cb: (presence: Map<string, Presence>) => void): Unsubscribe {
  return onSnapshot(collection(db, "presence"), (snap) => {
    cb(
      new Map(
        snap.docs.map((d) => {
          const data = d.data();
          return [
            d.id,
            {
              lastSeen: toDate(data.lastSeen)?.getTime() ?? Date.now(),
              where: typeof data.where === "string" ? data.where : "",
              whereAt: toDate(data.whereAt)?.getTime() ?? 0,
              streaming:
                data.streaming?.serverId && data.streaming?.channelId
                  ? {
                      serverId: data.streaming.serverId as string,
                      channelId: data.streaming.channelId as string,
                      ...(typeof data.streaming.team === "string" ? { team: data.streaming.team as string } : {}),
                    }
                  : undefined,
            },
          ];
        }),
      ),
    );
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
export async function createServer(uid: string, name: string, channels?: Omit<Channel, "id">[], open = false) {
  const ref = doc(collection(db, "servers"));
  // The server first: the channel rules look the server up, and a write in
  // the same batch is not visible to that lookup yet.
  await setDoc(ref, { name, ownerUid: uid, memberUids: [uid], open, createdAt: serverTimestamp() });
  const batch = writeBatch(db);
  const start = channels ?? [
    { name: "general", kind: "text", position: 0 },
    { name: "Lounge", kind: "voice", position: 1 },
  ];
  for (const ch of start) batch.set(doc(collection(ref, "channels")), ch);
  await batch.commit();
  audit("server.create", { serverId: ref.id, target: name });
  return ref.id;
}

/** The home server, made once by the operator on first sign-in. */
export async function ensureHomeServer(uid: string) {
  const mine = await getDocs(query(collection(db, "servers"), where("memberUids", "array-contains", uid)));
  if (!mine.empty) return;
  // The Living Room tile and its chat are added by the app once it watches
  // this server's channels (ensureHomeTiles), so they are made exactly once.
  await createServer(
    uid,
    "Digital House",
    [
      { name: "general", kind: "text", position: 1 },
      { name: "Lounge", kind: "voice", position: 2 },
    ],
    true, // open: everyone who gets in through M2A-access is in it
  );
}

/**
 * Everyone who gets in (an approved member, past the M2A-access door) is in
 * every open server: add yourself to any you are not in yet. The rules let
 * you add exactly yourself to an open server and nothing else.
 */
export async function joinOpenServers(uid: string) {
  const open = await getDocs(query(collection(db, "servers"), where("open", "==", true)));
  for (const s of open.docs) {
    const members = (s.data().memberUids as string[] | undefined) ?? [];
    if (!members.includes(uid)) await updateDoc(s.ref, { memberUids: arrayUnion(uid) }).catch(() => {});
  }
}

/**
 * The home server's built-in tiles, each with its chat, made once: the
 * Living Room (#livingroom-chat) and the M2A ACCESS Operation Room
 * (#operation-room), in that order above the other channels. Also renames
 * an older "Living" tile and gives a tile without one its chat.
 */
export async function ensureHomeTiles(sid: string, channels: Channel[]) {
  const channelsRef = collection(db, "servers", sid, "channels");
  // The built-in tiles sit above everything else, in HOME_TILES order.
  const others = channels.filter((c) => !isBuiltInTile(c) && !c.parentId);
  const top = others.reduce((min, c) => Math.min(min, c.position), 0) - HOME_TILES.length;
  for (const [i, { tile: spec, chat }] of HOME_TILES.entries()) {
    const position = top + i;
    let tile = channels.find((c) => c.kind === "room" && c.roomKey === spec.roomKey);
    if (!tile) {
      const ref = await addDoc(channelsRef, { ...spec, position });
      tile = { id: ref.id, ...spec, position };
    } else if (tile.name !== spec.name || tile.position !== position) {
      await updateDoc(doc(channelsRef, tile.id), { name: spec.name, position });
    }
    if (!channels.some((c) => c.parentId === tile!.id)) {
      await addDoc(channelsRef, { name: chat, kind: "text", position, parentId: tile.id });
    }
  }
}

/** The first server of yours that has a tile for this Gestr room (the wall). */
export async function findRoomTile(uid: string, roomKey: string) {
  const mine = await getDocs(query(collection(db, "servers"), where("memberUids", "array-contains", uid)));
  for (const s of mine.docs) {
    const tiles = await getDocs(query(collection(db, "servers", s.id, "channels"), where("roomKey", "==", roomKey)));
    const tile = tiles.docs[0];
    if (tile) return { serverId: s.id, channel: { id: tile.id, ...(tile.data() as Omit<Channel, "id">) } };
  }
  return null;
}

/** A new room tile and its own chat channel. */
export async function createRoomTile(
  sid: string,
  name: string,
  position: number,
  extra: { image: string; url: string },
) {
  const channelsRef = collection(db, "servers", sid, "channels");
  const tile = await addDoc(channelsRef, { name, kind: "room", position, ...extra });
  await addDoc(channelsRef, { name: tileChatName(name), kind: "text", position, parentId: tile.id });
  audit("tile.create", { serverId: sid, target: name, detail: extra.url });
  return tile.id;
}

export const renameServer = (sid: string, name: string) =>
  logged(updateDoc(doc(db, "servers", sid), { name }), "server.rename", { serverId: sid, target: name });

/** Name and banner together (Server settings). banner null removes it. */
export const saveServerSettings = (sid: string, name: string, banner: string | null | undefined, open: boolean) =>
  logged(
    updateDoc(doc(db, "servers", sid), {
      name,
      open,
      ...(banner === undefined ? {} : { banner: banner === null ? deleteField() : banner }),
    }),
    "server.settings",
    {
      serverId: sid,
      target: name,
      detail: `${open ? "open to everyone" : "closed"}${banner === undefined ? "" : banner === null ? ", banner removed" : ", banner changed"}`,
    },
  );

export const setServerOpen = (sid: string, open: boolean) =>
  logged(updateDoc(doc(db, "servers", sid), { open }), "server.open", { serverId: sid, detail: open ? "open to everyone" : "closed" });

/**
 * Remove a whole server: every channel's messages, the channels, then the
 * server. Only its owner may (rules); the app never offers it for the home
 * server.
 */
export async function deleteServer(sid: string) {
  const channels = await getDocs(collection(db, "servers", sid, "channels"));
  for (const c of channels.docs) {
    const messages = await getDocs(collection(c.ref, "messages"));
    for (const m of messages.docs) await deleteDoc(m.ref);
    await deleteDoc(c.ref);
  }
  await deleteDoc(doc(db, "servers", sid));
  audit("server.delete", { serverId: sid });
}
export const addServerMembers = (sid: string, uids: string[]) =>
  logged(updateDoc(doc(db, "servers", sid), { memberUids: arrayUnion(...uids) }), "member.add", { serverId: sid, target: uids.join(",") });
export const removeServerMember = (sid: string, uid: string) =>
  logged(updateDoc(doc(db, "servers", sid), { memberUids: arrayRemove(uid) }), "member.remove", { serverId: sid, target: uid });

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
) =>
  logged(addDoc(collection(db, "servers", sid, "channels"), { name, kind, position, ...extra }), "channel.create", {
    serverId: sid,
    target: name,
    detail: kind,
  });

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
/** A room tile's picture (a JPEG data URL, as when the tile was made). */
export const setTileImage = (sid: string, cid: string, image: string, tileName = "") =>
  logged(updateDoc(doc(db, "servers", sid, "channels", cid), { image }), "tile.picture", { serverId: sid, target: tileName || cid });
export const renameChannel = (sid: string, cid: string, name: string) =>
  logged(updateDoc(doc(db, "servers", sid, "channels", cid), { name }), "channel.rename", { serverId: sid, target: name });
/**
 * A channel and every message in it. Firestore never deletes a document's
 * subcollection on its own, so the messages go first, a few hundred at a
 * time; whoever runs the server may delete any message.
 */
export async function deleteChannel(sid: string, cid: string) {
  const messages = collection(db, "servers", sid, "channels", cid, "messages");
  for (;;) {
    const page = await getDocs(query(messages, limit(400)));
    if (page.empty) break;
    const batch = writeBatch(db);
    page.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  await deleteDoc(doc(db, "servers", sid, "channels", cid));
}

/** A room tile goes with its own chat channel(s). */
export async function deleteRoomTile(sid: string, tileId: string, channels: Channel[]) {
  for (const c of channels) if (c.parentId === tileId) await deleteChannel(sid, c.id);
  await deleteChannel(sid, tileId);
  audit("tile.delete", { serverId: sid, target: channels.find((c) => c.id === tileId)?.name ?? tileId });
}

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
        text: (data.text as string) ?? "",
        files: Array.isArray(data.files) ? (data.files as ChatFile[]) : [],
        sticker: data.sticker?.url ? (data.sticker as Sticker) : undefined,
        reactions: data.reactions && typeof data.reactions === "object" ? (data.reactions as Record<string, string[]>) : {},
        // a message we just sent has no server time yet: show it as now
        createdAt: toDate(data.createdAt) ?? new Date(),
        editedAt: toDate(data.editedAt),
      };
    });
    cb(rows.reverse());
  });
}

export const sendMessage = (
  sid: string,
  cid: string,
  authorUid: string,
  text: string,
  files: ChatFile[] = [],
  sticker?: Sticker,
) =>
  addDoc(collection(db, "servers", sid, "channels", cid, "messages"), {
    authorUid,
    text,
    ...(files.length ? { files } : {}),
    ...(sticker ? { sticker } : {}),
    createdAt: serverTimestamp(),
  });

/** Add (on) or take back your reaction on a message, like Discord. */
export const reactToMessage = (sid: string, cid: string, mid: string, uid: string, emoji: string, on: boolean) =>
  updateDoc(
    doc(db, "servers", sid, "channels", cid, "messages", mid),
    new FieldPath("reactions", emoji),
    on ? arrayUnion(uid) : arrayRemove(uid),
  );

export const editMessage = (sid: string, cid: string, mid: string, authorUid: string, text: string) =>
  updateDoc(doc(db, "servers", sid, "channels", cid, "messages", mid), {
    authorUid,
    text,
    editedAt: serverTimestamp(),
  });

export const deleteMessage = (sid: string, cid: string, mid: string) =>
  deleteDoc(doc(db, "servers", sid, "channels", cid, "messages", mid));

// ---- the server's own emojis -------------------------------------------------

/**
 * A server emoji (a picture or a little GIF), used in chat as :name:, or a
 * sticker (kind "sticker"): sent on its own, shown bigger.
 */
export type Emoji = {
  id: string;
  name: string;
  url: string;
  addedBy: string;
  animated: boolean;
  kind?: "emoji" | "sticker";
};

/** A sticker as sent in a message. */
export type Sticker = { url: string; name: string };

export function watchEmojis(sid: string, cb: (emojis: Emoji[]) => void): Unsubscribe {
  return onSnapshot(collection(db, "servers", sid, "emojis"), (snap) => {
    const rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Emoji, "id">) }));
    cb(rows.sort((a, b) => a.name.localeCompare(b.name)));
  });
}

export const addEmoji = (sid: string, emoji: Omit<Emoji, "id">) =>
  logged(addDoc(collection(db, "servers", sid, "emojis"), { ...emoji, createdAt: serverTimestamp() }), "emoji.add", {
    serverId: sid,
    target: `:${emoji.name}:`,
    detail: emoji.kind === "sticker" ? "sticker" : "emoji",
  });

export const deleteEmoji = (sid: string, id: string, name = "") =>
  logged(deleteDoc(doc(db, "servers", sid, "emojis", id)), "emoji.delete", { serverId: sid, target: name ? `:${name}:` : id });
