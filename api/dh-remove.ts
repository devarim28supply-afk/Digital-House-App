import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Remove one person from a videochat. Only the server's owner and admins.
 *
 *   POST /api/dh-remove   Authorization: Bearer <Firebase ID token>
 *   body { serverId, channelId, identity }     identity = the person's uid
 *
 * As in dh-token.ts, Firestore itself checks the caller: servers/{serverId}
 * is read with their own ID token (members only), which also makes the uid in
 * the token trustworthy. They must own that server, or be an approved admin
 * (members/{uid} roles.admin, or the owner account). The person is only
 * disconnected, not banned: they can join again. The server's owner and you
 * yourself cannot be removed here (use Disconnect for yourself).
 *
 * Env: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.
 */

const PROJECT_ID = "gestr-lab";
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OWNER_EMAIL = "kaalobmoran@gmail.com";

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

/** The claims of a Firebase ID token. Only trusted after Firestore accepts it. */
function claimsOf(idToken: string): { sub?: string; email?: string } {
  try {
    return JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

/** An approved admin, or the owner account. Anything unclear fails closed. */
async function isAdmin(idToken: string, uid: string, email: string) {
  const res = await fetch(`${FIRESTORE}/members/${uid}`, { headers: { Authorization: `Bearer ${idToken}` } });
  const owner = email.toLowerCase() === OWNER_EMAIL;
  // The owner has no members record: Firestore answers 404 to a genuine token.
  if (!res.ok) return owner && res.status === 404;
  if (owner) return true;
  const data = (await res.json()) as {
    fields?: {
      status?: { stringValue?: string };
      roles?: { mapValue?: { fields?: Record<string, { booleanValue?: boolean }> } };
    };
  };
  if (data.fields?.status?.stringValue !== "approved") return false;
  return data.fields?.roles?.mapValue?.fields?.admin?.booleanValue === true;
}

function adminPass(apiKey: string, apiSecret: string, room: string) {
  const b64 = (v: string) => Buffer.from(v).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ iss: apiKey, sub: "dh-remove", nbf: now - 10, exp: now + 60, video: { roomAdmin: true, room } }));
  const sig = createHmac("sha256", apiSecret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
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

  const body = await readBody(req);
  const serverId = String(body.serverId ?? "");
  const channelId = String(body.channelId ?? "");
  const identity = String(body.identity ?? "");
  if (!ID_RE.test(serverId) || !ID_RE.test(channelId) || !ID_RE.test(identity)) return send(res, 400, { error: "Bad request" });

  const serverRes = await fetch(`${FIRESTORE}/servers/${serverId}`, { headers: { Authorization: `Bearer ${idToken}` } });
  if (serverRes.status === 401) return send(res, 401, { error: "Your login has expired. Log in again." });
  if (!serverRes.ok) return send(res, 403, { error: "You are not in this server" });

  const claims = claimsOf(idToken);
  const uid = claims.sub ?? "";
  if (!ID_RE.test(uid)) return send(res, 401, { error: "Log in first" });
  const server = (await serverRes.json()) as { fields?: { ownerUid?: { stringValue?: string } } };
  const ownerUid = server.fields?.ownerUid?.stringValue ?? "";

  if (uid !== ownerUid && !(await isAdmin(idToken, uid, String(claims.email ?? "")))) {
    return send(res, 403, { error: "Only the server's owner and admins can remove someone" });
  }
  if (identity === uid) return send(res, 400, { error: "Use Disconnect to leave the call yourself" });
  if (identity === ownerUid) return send(res, 403, { error: "The server's owner cannot be removed" });

  // the videochat only (dh-token.ts names it); the 3D room is a different LiveKit room
  const room = `dh-${serverId}-${channelId}`;
  let lk: Response;
  try {
    lk = await fetch(`${LIVEKIT_URL.replace(/^ws/, "http")}/twirp/livekit.RoomService/RemoveParticipant`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminPass(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, room)}` },
      body: JSON.stringify({ room, identity }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return send(res, 502, { error: "Could not reach the call server. Try again." });
  }
  if (lk.status === 404) return send(res, 404, { error: "They are not in the call any more" });
  if (!lk.ok) return send(res, 502, { error: "The call server refused. Try again." });
  send(res, 200, { ok: true });
}
