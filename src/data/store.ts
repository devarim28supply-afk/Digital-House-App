import { availabilityStatus, type Availability } from "./status";
import { customization, type Customization } from "./customization";
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
  getDoc,
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
  /** Public display name across status, chat, profiles and calls; legacy field name. */
  callName?: string;
  availability?: Availability;
  customization?: Customization;
  /** the three pictures on your profile card: uploaded URLs (a GIF keeps moving) */
  photo?: string;
  banner?: string;
  background?: string;
}
/** Resolve the public name from the live profile, keeping account identity unchanged. */
export function displayName(profile: Pick<Profile, "callName" | "name" | "username"> | undefined, fallback = "Member"): string {
  return profile?.callName?.trim() || profile?.name?.trim() || profile?.username?.trim() || fallback;
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
  /** 8-character code an approved member can enter to join this server */
  inviteCode?: string;
  /**
   * "dm": a direct message between two people (data/dms.ts), not a server.
   * "server" (every server made from here on): the oversight dashboard's
   * admin query filters on this field, so it is never left unset.
   * Older servers made before this field existed carry neither value.
   */
  kind?: "dm" | "server";
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
  // The operation booth behind the bunker's one-way glass (M2A-access is / live).
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
 * CSS 3D room where everyone walks around as their webcam). The Operation
 * Room is not one of these: it opens the M2A bunker. Every other tile
 * opens only its videochat for now, Room greyed out.
 */
const DARKWOOD_ROOM_TILES = new Set(["gestr-living"]);

export const hasDarkwoodRoom = (channel: Channel) => DARKWOOD_ROOM_TILES.has(channel.roomKey ?? "");

/**
 * Link tiles whose Room side is on: their link opens there. Other link tiles
 * (Don't Lie) stay videochat only, Room greyed out.
 */
const ROOM_LINK_SITES = new Set([
  "viperoneone.com", // VIPER 11 theater
  "rimyshrimp-white-torture-br.vercel.app", // White Torture
]);

/**
 * Sites that refuse to be shown inside another page. Their Room side is our
 * own copy of that page (/api/...), so the game still plays here with the
 * call's webcams underneath.
 */
const PLAY_IN_PAGE = new Set(["rimyshrimp-white-torture-br.vercel.app"]);

function linkSite(url?: string) {
  try {
    return new URL(url ?? "").hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Off the left sidebar for now. The channels stay. */
const HIDDEN_SIDEBAR_SITES = new Set([
  "dont-lie.vercel.app",
  "viperoneone.com",
  "rimyshrimp-white-torture-br.vercel.app",
]);

export function hiddenFromSidebar(channel: Channel) {
  const name = channel.name.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "");
  if (name === "dontlie" || name.startsWith("dontlie") || name === "whitetorture" || name.startsWith("whitetorture") || name === "viper11" || name.startsWith("viper11")) {
    return true;
  }
  return HIDDEN_SIDEBAR_SITES.has(linkSite(channel.url));
}

/**
 * The M2A bunker, one page for the whole visit. Window and Room only change
 * the camera, so switching does not reload it. People in it are the Living
 * Room hex plate and eye, not a MetaPhysical body.
 */
export function operationSessionUrl(_serverId: string, _channelId: string, view: "window" | "room") {
  const room = GESTR_ROOMS["m2a-operation"];
  const url = new URL(ON_THIS_PC() ? room.local : room.live, location.href);
  url.searchParams.set("spawn", "operation");
  url.searchParams.set("view", view);
  url.searchParams.delete("fixed");
  return url.href;
}

/** The page a tile's Room side shows, or "" when it has none. */
export function roomUrlOf(channel: Channel, serverId: string) {
  if (channel.roomKey === "m2a-operation") return operationSessionUrl(serverId, channel.id, "window");
  if (!channel.roomKey && ROOM_LINK_SITES.has(linkSite(channel.url))) {
    if (PLAY_IN_PAGE.has(linkSite(channel.url))) return "/api/white-torture";
    return channel.url!;
  }
  if (!hasDarkwoodRoom(channel)) return "";
  const q = new URLSearchParams({ s: serverId, c: channel.id });
  return `${import.meta.env.BASE_URL}room.html?${q}`;
}

export const LIVING_TILE: Omit<Channel, "id" | "position"> = {
  name: "Node Lounge",
  kind: "room",
  image: "/living.png",
  roomKey: "gestr-living",
};

/** The booth behind the bunker's window. You spawn in it. */
export const OPERATION_TILE: Omit<Channel, "id" | "position"> = {
  name: "M2A ACCESS Operation Room",
  kind: "room",
  image: "/operation-room.jpg",
  roomKey: "m2a-operation",
};

/** The home server's built-in tiles, top to bottom, each with its own chat. */
const HOME_TILES: { tile: Omit<Channel, "id" | "position">; chat: string }[] = [
  { tile: OPERATION_TILE, chat: "operation-room" },
  { tile: LIVING_TILE, chat: tileChatName(LIVING_TILE.name) }, // #nodelounge-chat
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

/** Save profile appearance and the optional public display name; account identity is unchanged. */
export async function saveCustomization(uid: string, value: Customization, photo?: string, banner?: string, displayName?: string) {
  const cleanName = displayName?.trim().slice(0, 24);
  await setDoc(doc(db, "profiles", uid), {
    customization: customization(value),
    ...(photo !== undefined ? { photo: photo || deleteField() } : {}),
    ...(banner !== undefined ? { banner: banner || deleteField() } : {}),
    ...(cleanName !== undefined ? { callName: cleanName || deleteField() } : {}),
  }, { merge: true });
}

/** Manual member status; this updates only the signed-in user's public profile. */
export async function saveAvailability(uid: string, status: Availability) {
  await setDoc(doc(db, "profiles", uid), { availability: availabilityStatus(status) }, { merge: true });
}

export function watchProfiles(cb: (profiles: Map<string, Profile>) => void): Unsubscribe {
  return onSnapshot(collection(db, "profiles"), (snap) => {
    cb(new Map(snap.docs.map((d) => [d.id, { uid: d.id, ...(d.data() as Omit<Profile, "uid">) }])));
  });
}

// ---- presence ---------------------------------------------------------------

// Every heartbeat is read again by every open app, so reads grow with
// (people online)² / beat. 75 s keeps the window at 2.4 beats.
const HEARTBEAT_MS = 75_000;
// Coming back to the tab beats at once, but never more than this often.
const MIN_BEAT_GAP_MS = 20_000;
export const ONLINE_WINDOW_MS = 3 * 60_000;

/** Write a heartbeat now and every 75 s while the page is open. */
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
  let lastBeat = 0;
  const beat = () => {
    lastBeat = Date.now();
    return setDoc(ref, where ? { lastSeen: serverTimestamp(), where, whereAt: serverTimestamp() } : { lastSeen: serverTimestamp() }, {
      merge: true,
    }).catch(() => {});
  };
  beat();
  const timer = window.setInterval(beat, HEARTBEAT_MS);
  const onVisible = () => document.visibilityState === "visible" && Date.now() - lastBeat > MIN_BEAT_GAP_MS && beat();
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
  const repairing = new Set<string>();
  let asMember: Server[] = [];
  let asOwner: Server[] = [];
  let asOpen: Server[] = [];
  const emit = () => {
    const byId = new Map<string, Server>();
    // An open server shows for every approved member, not only people already
    // written on memberUids. The owner also sees a closed server he owns.
    for (const s of [...asMember, ...asOwner, ...asOpen]) byId.set(s.id, s);
    const servers = [...byId.values()];
    servers.sort((a, b) => a.name.localeCompare(b.name));
    cb(servers);
    for (const s of servers) {
      if (s.kind === "dm" || repairing.has(s.id)) continue;
      const patch: { memberUids?: ReturnType<typeof arrayUnion>; open?: true } = {};
      const home = s.ownerUid === uid && s.name.startsWith("Digital House");
      if ((home || s.open === true) && !s.memberUids.includes(uid)) patch.memberUids = arrayUnion(uid);
      // The lock wrote open:false. Digital House is open to everyone approved.
      if (home && s.open !== true) patch.open = true;
      if (home) void restoreHomeMembers(s.id).catch(() => {});
      if (!patch.memberUids && patch.open !== true) continue;
      repairing.add(s.id);
      void updateDoc(doc(db, "servers", s.id), patch).catch(() => repairing.delete(s.id));
    }
  };
  const map = (snap: { docs: { id: string; data: () => Record<string, unknown> }[] }) =>
    snap.docs.map((d) => {
      const data = d.data() as Omit<Server, "id">;
      return { id: d.id, ...data, memberUids: data.memberUids ?? [] };
    });
  const unsubMember = onSnapshot(
    query(collection(db, "servers"), where("memberUids", "array-contains", uid)),
    (snap) => {
      asMember = map(snap);
      emit();
    },
    () => {
      asMember = [];
      emit();
    },
  );
  const unsubOwner = onSnapshot(
    query(collection(db, "servers"), where("ownerUid", "==", uid)),
    (snap) => {
      asOwner = map(snap);
      emit();
    },
    () => {
      asOwner = [];
      emit();
    },
  );
  const unsubOpen = onSnapshot(
    query(collection(db, "servers"), where("open", "==", true)),
    (snap) => {
      asOpen = map(snap).filter((s) => s.kind !== "dm");
      emit();
    },
    () => {
      asOpen = [];
      emit();
    },
  );
  return () => {
    unsubMember();
    unsubOwner();
    unsubOpen();
  };
}

/**
 * Every server, for the oversight dashboard (admins only; rules:
 * M2A-Access-Control's firestore.rules, servers/{sid} isAdmin() read). DMs
 * are excluded there too, so this never lists a private conversation.
 */
export function watchAllServers(cb: (servers: Server[]) => void, onError?: (err: Error) => void): Unsubscribe {
  // where("kind","!=","dm") matches the rule's own condition exactly (the
  // reason every server now carries kind:"server": Firestore excludes a
  // document from a "!=" query if the field is missing, which is also why a
  // server made before this field existed would not show up here until
  // migrated). The client-side filter stays as a second, harmless check.
  return onSnapshot(
    query(collection(db, "servers"), where("kind", "!=", "dm")),
    (snap) => {
      const servers = snap.docs
        .map((d) => {
          const data = d.data() as Omit<Server, "id">;
          return { id: d.id, ...data, memberUids: data.memberUids ?? [] };
        })
        .filter((s) => s.kind !== "dm");
      servers.sort((a, b) => a.name.localeCompare(b.name));
      cb(servers);
    },
    (err) => onError?.(err as unknown as Error),
  );
}

/** A new server with a text and a voice channel to start. */
export async function createServer(uid: string, name: string, channels?: Omit<Channel, "id">[], open = false) {
  const ref = doc(collection(db, "servers"));
  // The server first: the channel rules look the server up, and a write in
  // the same batch is not visible to that lookup yet.
  // kind:"server" (never unset after this) is what lets the oversight
  // dashboard's admin query filter DMs out at the database level, not only
  // in its own display: see watchAllServers and firestore.rules.
  await setDoc(ref, { name, ownerUid: uid, memberUids: [uid], open, kind: "server", createdAt: serverTimestamp() });
  const batch = writeBatch(db);
  const start = channels ?? [
    { name: "general", kind: "text", position: 0 },
    { name: "Lounge", kind: "voice", position: 1 },
  ];
  for (const ch of start) batch.set(doc(collection(ref, "channels")), ch);
  await batch.commit();
  audit("server.create", { serverId: ref.id, target: name });
  await setInviteCode(ref.id).catch(() => {});
  return ref.id;
}

// Invite codes. An approved member who has the code joins that server.
// invites/{code} is the lookup (you can read a code you already know, not the
// list). The server document holds the same code, and the join proof is
// servers/{id}/joins/{uid}. Rules check the proof before you add yourself.
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function normalizeInviteCode(raw: string) {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function makeInviteCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join("");
}

/** A new code for this server. The previous code stops working. */
export async function setInviteCode(sid: string) {
  const serverRef = doc(db, "servers", sid);
  const current = await getDoc(serverRef);
  if (!current.exists()) throw new Error("That server is gone.");
  if (current.data().kind === "dm") throw new Error("A direct message has no invite code.");
  const old = typeof current.data().inviteCode === "string" ? current.data().inviteCode : "";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code = makeInviteCode();
    const taken = await getDoc(doc(db, "invites", code));
    if (!taken.exists()) break;
    code = "";
  }
  if (!code) throw new Error("Could not make a code. Try again.");
  await updateDoc(serverRef, { inviteCode: code });
  await setDoc(doc(db, "invites", code), { serverId: sid });
  if (old && old !== code) await deleteDoc(doc(db, "invites", old)).catch(() => {});
  audit("server.invite", { serverId: sid });
  return code;
}

/** The server id behind a code, or an error when nothing uses it. */
export async function lookupInvite(raw: string) {
  const code = normalizeInviteCode(raw);
  if (code.length !== 8) throw new Error("Enter the 8-character code.");
  const snap = await getDoc(doc(db, "invites", code));
  const serverId = snap.data()?.serverId;
  if (!snap.exists() || typeof serverId !== "string" || !serverId) throw new Error("No server uses that code.");
  return { serverId, code };
}

/** Add yourself to the server this code belongs to. */
export async function redeemInvite(uid: string, serverId: string, code: string) {
  await setDoc(doc(db, "servers", serverId, "joins", uid), { code });
  await updateDoc(doc(db, "servers", serverId), { memberUids: arrayUnion(uid) });
  audit("member.add", { serverId, detail: "invite code" });
}

/** The home server, made once by the operator on first sign-in. Reopens Digital House if the lock closed it. */
export async function ensureHomeServer(uid: string) {
  const [mine, owned] = await Promise.all([
    getDocs(query(collection(db, "servers"), where("memberUids", "array-contains", uid))).catch(() => null),
    getDocs(query(collection(db, "servers"), where("ownerUid", "==", uid))).catch(() => null),
  ]);
  const docs = new Map(mine?.docs.map((d) => [d.id, d]) ?? []);
  for (const d of owned?.docs ?? []) docs.set(d.id, d);
  let hasReal = false;
  for (const s of docs.values()) {
    const data = s.data();
    if (data.kind === "dm") continue;
    hasReal = true;
    if (data.ownerUid !== uid) continue;
    const members = (data.memberUids as string[] | undefined) ?? [];
    const patch: { memberUids?: ReturnType<typeof arrayUnion>; open?: true } = {};
    if (!members.includes(uid)) patch.memberUids = arrayUnion(uid);
    if (typeof data.name === "string" && data.name.startsWith("Digital House") && data.open !== true) patch.open = true;
    if (patch.memberUids || patch.open) await updateDoc(s.ref, patch).catch(() => {});
  }
  if (hasReal) return;
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

const restoredHomes = new Set<string>();
/**
 * Digital House: every approved member goes back on the server. arrayUnion
 * only adds, so nobody already there is removed. Open stays on.
 */
export async function restoreHomeMembers(sid: string) {
  if (restoredHomes.has(sid)) return;
  restoredHomes.add(sid);
  try {
    const snap = await getDocs(query(collection(db, "members"), where("status", "==", "approved")));
    const uids = snap.docs.map((d) => d.id);
    const before = await getDoc(doc(db, "servers", sid));
    const existing = new Set<string>((before.data()?.memberUids as string[] | undefined) ?? []);
    const added = uids.filter((u) => !existing.has(u));
    const wasOpen = before.data()?.open === true;
    for (let i = 0; i < uids.length; i += 100) {
      const chunk = uids.slice(i, i + 100);
      if (chunk.length) await updateDoc(doc(db, "servers", sid), { memberUids: arrayUnion(...chunk) });
    }
    if (!wasOpen) await updateDoc(doc(db, "servers", sid), { open: true });
    // only the pure routine re-check (nothing actually changed) stays quiet;
    // log only when this run truly added someone or opened the server
    if (added.length || !wasOpen) audit("member.add", { serverId: sid, detail: `restored ${added.length} approved member${added.length === 1 ? "" : "s"}` });
  } catch (err) {
    restoredHomes.delete(sid);
    throw err;
  }
}

/**
 * The home server's built-in tiles, each with its chat, made once: the
 * M2A ACCESS Operation Room (#operation-room) and Node Lounge
 * (#nodelounge-chat), in that order above the other channels. Also renames
 * an older Living Room tile and its chat, and gives a tile without one its chat.
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
    const text = channels.find((c) => c.kind === "text" && c.parentId === tile.id);
    if (!text) {
      await addDoc(channelsRef, { name: chat, kind: "text", position, parentId: tile.id });
    } else if (text.name !== chat) {
      await updateDoc(doc(channelsRef, text.id), { name: chat });
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
