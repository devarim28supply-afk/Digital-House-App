import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Live calls, for the Dashboard's LiveKit panel (staff only).
 *
 *   POST /api/dh-rooms   Authorization: Bearer <Firebase ID token>
 *   body {}                                 list every live Darkwood call
 *   body { action: "end", room: "dh-..." }   disconnect everyone from one call
 *   body { action: "watch", room: "dh-..." } a hidden, subscribe-only pass to
 *                                            watch one call live (the client
 *                                            logs oversight.view/call.watch
 *                                            once it actually connects, same
 *                                            as Oversight does for a server)
 *
 * The LiveKit project is shared with other Gestr apps, so this only ever
 * looks at rooms named "dh-<serverId>-<channelId>" (optionally "--room" for
 * a tile's 3D room) - Darkwood Node's own naming (api/dh-token.ts). The
 * caller is checked the same way dh-remove.ts does: members/{uid} read with
 * their own ID token, requiring staff (roles.staff or roles.develop) or the
 * owner account.
 *
 * Env: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.
 */

const PROJECT_ID = "gestr-lab";
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const OWNER_EMAIL = "kaalobmoran@gmail.com";
// Server and channel ids here are either Firestore auto-ids (alphanumeric,
// no hyphen) or a DM's own ids ("dm_<uid>_<uid>", "chat"/"call" - underscores,
// no hyphen either), so the id groups themselves must exclude "-": it is
// only ever the literal separator, never part of an id.
const ROOM_RE = /^dh-([A-Za-z0-9_]{1,64})-([A-Za-z0-9_]{1,64})(--room)?$/;

/**
 * A real Darkwood server/tile room, never a DM. A DM's own "server" id is
 * always "dm_<uidA>_<uidB>" (src/data/dms.ts, dmIdFor) - a direct message is
 * private, never oversight's or Live calls' business, same boundary
 * Oversight itself draws (notDm() in firestore.rules).
 */
function isDarkwoodRoom(name: string): RegExpExecArray | null {
  const m = ROOM_RE.exec(name);
  if (!m) return null;
  return m[1].startsWith("dm_") ? null : m;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const pre = (req as IncomingMessage & { body?: unknown }).body;
  if (pre && typeof pre === "object") return pre as Record<string, unknown>;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

function claimsOf(idToken: string): { sub?: string; email?: string; name?: string } {
  try {
    return JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

/** Staff (roles.staff or roles.develop), or the owner account. Anything unclear fails closed. */
async function isStaff(idToken: string, uid: string, email: string) {
  const res = await fetch(`${FIRESTORE}/members/${uid}`, { headers: { Authorization: `Bearer ${idToken}` } });
  const owner = email.toLowerCase() === OWNER_EMAIL;
  if (!res.ok) return owner && res.status === 404;
  if (owner) return true;
  const data = (await res.json()) as {
    fields?: {
      status?: { stringValue?: string };
      roles?: { mapValue?: { fields?: Record<string, { booleanValue?: boolean }> } };
    };
  };
  if (data.fields?.status?.stringValue !== "approved") return false;
  const roles = data.fields?.roles?.mapValue?.fields;
  return roles?.staff?.booleanValue === true || roles?.develop?.booleanValue === true;
}

function adminPass(apiKey: string, apiSecret: string) {
  const b64 = (v: string) => Buffer.from(v).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  // roomList covers ListRooms/ListParticipants; roomAdmin covers DeleteRoom.
  const body = b64(JSON.stringify({ iss: apiKey, sub: "dh-rooms", nbf: now - 10, exp: now + 60, video: { roomList: true, roomAdmin: true } }));
  const sig = createHmac("sha256", apiSecret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

// Hidden and subscribe-only, same grant shape as api/dh-token.ts's own
// watch-only pass (the 3D room's "wall" and a LIVE tile's "peek") - the
// watcher never appears in the room's participant list to anyone in it.
function watchPass(apiKey: string, apiSecret: string, uid: string, name: string, room: string) {
  const b64 = (v: string) => Buffer.from(v).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(
    JSON.stringify({
      iss: apiKey,
      sub: `${uid}:oversight-watch`,
      name,
      nbf: now - 10,
      exp: now + 60 * 60,
      video: { room, roomJoin: true, hidden: true, canPublish: false, canSubscribe: true, canPublishData: false },
    }),
  );
  const sig = createHmac("sha256", apiSecret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

type LkRoom = { name?: string; sid?: string; numParticipants?: number; creationTime?: string };
type LkTrack = { type?: "AUDIO" | "VIDEO"; muted?: boolean };
type LkParticipant = { identity?: string; name?: string; joinedAt?: string; connectionQuality?: "POOR" | "GOOD" | "EXCELLENT" | "UNKNOWN"; tracks?: LkTrack[] };

async function twirp<T>(base: string, apiKey: string, apiSecret: string, method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${base.replace(/^ws/, "http")}/twirp/livekit.RoomService/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminPass(apiKey, apiSecret)}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`LiveKit ${method} refused (${res.status})`);
  return (await res.json()) as T;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });

  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return send(res, 500, { error: "LiveKit is not set up on this server" });
  }

  const auth = req.headers.authorization ?? "";
  const idToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!idToken) return send(res, 401, { error: "Log in first" });

  const claims = claimsOf(idToken);
  const uid = claims.sub ?? "";
  if (!uid) return send(res, 401, { error: "Log in first" });
  if (!(await isStaff(idToken, uid, String(claims.email ?? "")))) {
    return send(res, 403, { error: "Staff only" });
  }

  const body = await readBody(req);

  try {
    if (body.action === "end") {
      const room = String(body.room ?? "");
      if (!isDarkwoodRoom(room)) return send(res, 400, { error: "Bad request" });
      await twirp(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, "DeleteRoom", { room });
      return send(res, 200, { ok: true });
    }

    if (body.action === "watch") {
      const room = String(body.room ?? "");
      if (!isDarkwoodRoom(room)) return send(res, 400, { error: "Bad request" });
      const name = claims.name || (claims.email ?? "").split("@")[0] || "Staff";
      return send(res, 200, { url: LIVEKIT_URL, token: watchPass(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, uid, name, room) });
    }

    const { rooms } = await twirp<{ rooms?: LkRoom[] }>(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, "ListRooms", {});
    const darkwood = (rooms ?? []).filter((r) => r.name && isDarkwoodRoom(r.name));
    const withParticipants = await Promise.all(
      darkwood.map(async (r) => {
        const m = isDarkwoodRoom(r.name ?? "");
        let participants: LkParticipant[] = [];
        let rosterOk = false;
        try {
          const list = await twirp<{ participants?: LkParticipant[] }>(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, "ListParticipants", { room: r.name });
          participants = list.participants ?? [];
          rosterOk = true;
        } catch {
          /* this one room's roster failed; still show the room itself */
        }
        return {
          name: r.name,
          serverId: m?.[1] ?? "",
          channelId: m?.[2] ?? "",
          is3dRoom: Boolean(m?.[3]),
          // the roster (when it loaded) is the true count - ListRooms' own
          // numParticipants can read 0 for a moment right after someone
          // joins, and "0 ?? participants.length" never falls through a
          // real 0, so it would otherwise show stale "0 in call".
          numParticipants: rosterOk ? participants.length : (r.numParticipants ?? 0),
          creationTime: r.creationTime,
          participants: participants.map((p) => ({
            identity: p.identity ?? "",
            name: p.name ?? "",
            joinedAt: p.joinedAt,
            connectionQuality: p.connectionQuality ?? "UNKNOWN",
            audioMuted: (p.tracks ?? []).find((t) => t.type === "AUDIO")?.muted ?? true,
            videoMuted: (p.tracks ?? []).find((t) => t.type === "VIDEO")?.muted ?? true,
          })),
        };
      }),
    );
    send(res, 200, { rooms: withParticipants });
  } catch {
    send(res, 502, { error: "Could not reach the call server. Try again." });
  }
}
