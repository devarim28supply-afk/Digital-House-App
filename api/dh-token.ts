import { createHmac, createVerify } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * LiveKit pass for a Digital House voice channel.
 *
 *   POST /api/dh-token   Authorization: Bearer <Firebase ID token>
 *   body { serverId, channelId }
 *   body { serverId, channelId, room: true }   the tile's Darkwood Room
 *
 * The check is done by Firestore itself: we read servers/{serverId} with the
 * caller's own ID token, so the security rules decide (approved member AND
 * in that server's memberUids). A forged or expired token is refused there,
 * which also makes the uid we read from the token trustworthy.
 *
 * Env: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.
 */

const PROJECT_ID = "gestr-lab";
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const CERTS = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const PASS_SECONDS = 6 * 60 * 60;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

let certCache: { at: number; keys: Record<string, string> } | null = null;

async function googleCerts(): Promise<Record<string, string> | null> {
  if (certCache && Date.now() - certCache.at < 60 * 60 * 1000) return certCache.keys;
  const res = await fetch(CERTS);
  if (!res.ok) return certCache?.keys ?? null;
  const keys = (await res.json()) as Record<string, string>;
  certCache = { at: Date.now(), keys };
  return keys;
}

/** A signed-in Firebase user, checked with Google's public key. No Firestore read. */
async function signedIn(idToken: string): Promise<{ sub: string; name?: string; email?: string } | null> {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let payload: { sub?: string; aud?: string; iss?: string; exp?: number; name?: string; email?: string };
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid || !payload.sub) return null;
  if (payload.aud !== PROJECT_ID || payload.iss !== `https://securetoken.google.com/${PROJECT_ID}`) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
  const pem = (await googleCerts())?.[header.kid];
  if (!pem) return null;
  const ok = createVerify("RSA-SHA256").update(`${parts[0]}.${parts[1]}`).verify(pem, Buffer.from(parts[2], "base64url"));
  if (!ok) return null;
  return { sub: payload.sub, name: payload.name, email: payload.email };
}

function base64url(input: Buffer | string) {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function signPass(apiKey: string, apiSecret: string, identity: string, name: string, room: string, watchOnly = false) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: apiKey,
      sub: identity,
      name,
      nbf: now - 10,
      exp: now + PASS_SECONDS,
      video: watchOnly
        ? { room, roomJoin: true, hidden: true, canPublish: false, canSubscribe: true, canPublishData: false }
        : // canUpdateOwnMetadata: a person's attributes say which desk they hold (src/data/seats.ts)
          { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: true },
    }),
  );
  const signature = base64url(createHmac("sha256", apiSecret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
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

/** The claims of a Firebase ID token. Only trusted after Firestore accepts it. */
function claimsOf(idToken: string): { sub?: string; name?: string; email?: string } {
  try {
    return JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
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
  if (!ID_RE.test(serverId) || !ID_RE.test(channelId)) return send(res, 400, { error: "Bad channel" });

  const headers = { Authorization: `Bearer ${idToken}` };
  const serverRes = await fetch(`${FIRESTORE}/servers/${serverId}`, { headers });
  if (serverRes.status === 401) return send(res, 401, { error: "Your login has expired. Log in again." });
  if (!serverRes.ok) {
    const errText = await serverRes.text();
    let fsError = "";
    try {
      fsError = String(JSON.parse(errText).error?.status ?? "");
    } catch {
      fsError = "";
    }
    console.log(JSON.stringify({ step: "server", fs: serverRes.status, fsError }));
    // Firestore is out of reads. A signed-in member still gets into the call.
    if (serverRes.status === 429 || serverRes.status === 503) {
      const who = await signedIn(idToken);
      if (!who) return send(res, 401, { error: "Your login has expired. Log in again." });
      return issue(res, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, who, body, serverId, channelId);
    }
    return send(res, 403, { error: "You are not in this server" });
  }

  const claims = claimsOf(idToken);
  const uid = claims.sub ?? "";
  const server = (await serverRes.json()) as {
    fields?: {
      ownerUid?: { stringValue?: string };
      open?: { booleanValue?: boolean };
      memberUids?: { arrayValue?: { values?: { stringValue?: string }[] } };
    };
  };
  const members = server.fields?.memberUids?.arrayValue?.values?.map((v) => v.stringValue) ?? [];
  const ownerUid = server.fields?.ownerUid?.stringValue ?? "";
  const open = server.fields?.open?.booleanValue === true;
  const owner = Boolean(uid) && uid === ownerUid;
  const member = Boolean(uid) && members.includes(uid);
  if (!owner && !member && !open) {
    console.log(JSON.stringify({ step: "check", open, owner, member, count: members.length, uid: Boolean(uid) }));
    return send(res, 403, { error: "You are not in this server" });
  }

  const channelRes = await fetch(`${FIRESTORE}/servers/${serverId}/channels/${channelId}`, { headers });
  if (!channelRes.ok) {
    console.log(JSON.stringify({ step: "channel", fs: channelRes.status }));
    if (channelRes.status === 429 || channelRes.status === 503) {
      return issue(res, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { sub: uid, name: claims.name, email: claims.email }, body, serverId, channelId);
    }
    return send(res, 404, { error: "That channel is gone" });
  }

  return issue(res, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { sub: uid, name: claims.name, email: claims.email }, body, serverId, channelId);
}

function issue(
  res: ServerResponse,
  livekitUrl: string,
  apiKey: string,
  apiSecret: string,
  who: { sub: string; name?: string; email?: string },
  body: Record<string, unknown>,
  serverId: string,
  channelId: string,
) {
  // The tile's 3D room (room.html) is its own LiveKit room, apart from the
  // videochat, so walking around in it never shows up as a call tile.
  const room = `dh-${serverId}-${channelId}${body.room === true ? "--room" : ""}`;
  // The wall in a 3D room watches the call: invisible and watch-only, under
  // its own name so it never knocks your own app tab out of the same call.
  const wall = body.wall === true;
  // A LIVE tile's preview: invisible and watch-only too, one name per screen
  // so two screens never knock each other out.
  const peekTag = typeof body.peek === "string" && /^[a-z0-9]{1,12}$/.test(body.peek) ? body.peek : "";
  const name = who.name || (who.email ?? "").split("@")[0] || "Member";
  send(res, 200, {
    url: livekitUrl,
    token: signPass(
      apiKey,
      apiSecret,
      peekTag ? `${who.sub}:peek-${peekTag}` : wall ? `${who.sub}:wall` : who.sub,
      name,
      room,
      wall || Boolean(peekTag),
    ),
    room,
  });
}
