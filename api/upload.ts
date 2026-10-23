import type { IncomingMessage, ServerResponse } from "node:http";

import { type HandleUploadBody, handleUpload } from "@vercel/blob/client";

/**
 * Upload pass for a picture, video or file sent in a Darkwood Node chat.
 *
 *   POST /api/upload   (the @vercel/blob/client upload() handshake)
 *   clientPayload: JSON { idToken, serverId, channelId }      a chat file
 *                  JSON { idToken, serverId, kind: "emoji" }  a server emoji
 *
 * The browser uploads straight to Vercel Blob; this only hands out the pass.
 * The check is done by Firestore itself, as in dh-token.ts: we read the
 * server with the caller's own ID token, so the security rules decide, and
 * the uid must be in its memberUids. Up to 500 MB a file (Kaalob).
 *
 * Env: BLOB_READ_WRITE_TOKEN (the darkwood-node-files store).
 */

const PROJECT_ID = "gestr-lab";
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BYTES = 500 * 1024 * 1024;
// a server emoji: a small picture or a little GIF
const MAX_EMOJI_BYTES = 2 * 1024 * 1024;
const EMOJI_TYPES = ["image/png", "image/gif", "image/webp", "image/jpeg"];

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const pre = (req as IncomingMessage & { body?: unknown }).body;
  if (pre && typeof pre === "object") return pre;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

function claimsOf(idToken: string): { sub?: string } {
  try {
    return JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

/** The uploader's uid, once Firestore confirms they are in this server (and channel, if given). */
async function memberOf(idToken: string, serverId: string, channelId?: string) {
  if (!idToken || !ID_RE.test(serverId) || (channelId !== undefined && !ID_RE.test(channelId))) {
    throw new Error("Bad channel");
  }
  const headers = { Authorization: `Bearer ${idToken}` };
  const serverRes = await fetch(`${FIRESTORE}/servers/${serverId}`, { headers });
  if (serverRes.status === 401) throw new Error("Your login has expired. Log in again.");
  if (!serverRes.ok) throw new Error("You are not in this server");
  const uid = claimsOf(idToken).sub ?? "";
  const server = (await serverRes.json()) as {
    fields?: { memberUids?: { arrayValue?: { values?: { stringValue?: string }[] } } };
  };
  const members = server.fields?.memberUids?.arrayValue?.values?.map((v) => v.stringValue) ?? [];
  if (!uid || !members.includes(uid)) throw new Error("You are not in this server");
  if (channelId === undefined) return uid;
  const channelRes = await fetch(`${FIRESTORE}/servers/${serverId}/channels/${channelId}`, { headers });
  if (!channelRes.ok) throw new Error("That channel is gone");
  return uid;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return send(res, 500, { error: "File storage is not set up on this server" });
  const body = (await readBody(req)) as HandleUploadBody;
  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const payload = JSON.parse(clientPayload || "{}") as {
          idToken?: string;
          serverId?: string;
          channelId?: string;
          kind?: string;
        };
        if (payload.kind === "emoji") {
          const uid = await memberOf(payload.idToken ?? "", payload.serverId ?? "");
          if (!pathname.startsWith(`emoji/${payload.serverId}/`)) throw new Error("Bad file path");
          return {
            maximumSizeInBytes: MAX_EMOJI_BYTES,
            allowedContentTypes: EMOJI_TYPES,
            addRandomSuffix: true,
            tokenPayload: JSON.stringify({ uid }),
          };
        }
        const uid = await memberOf(payload.idToken ?? "", payload.serverId ?? "", payload.channelId ?? "");
        // files live under their channel, so a channel's files can be found later
        if (!pathname.startsWith(`chat/${payload.serverId}/${payload.channelId}/`)) throw new Error("Bad file path");
        return {
          maximumSizeInBytes: MAX_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ uid }),
        };
      },
      // The message itself is written by the browser once the upload is done.
      onUploadCompleted: async () => {},
    });
    send(res, 200, result);
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : "Upload refused" });
  }
}
