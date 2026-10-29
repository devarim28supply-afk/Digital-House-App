import type { IncomingMessage, ServerResponse } from "node:http";

import { list } from "@vercel/blob";

/**
 * Uploads and storage, for the Dashboard's Firebase/storage panel (staff
 * only). Everything Darkwood Node has ever uploaded to Vercel Blob lives in
 * one store (see api/upload.ts): chat files, server emojis and banners,
 * profile pictures, feedback screenshots.
 *
 *   POST /api/dh-uploads   Authorization: Bearer <Firebase ID token>
 *
 * The caller is checked the same way dh-rooms.ts does: members/{uid} read
 * with their own ID token, requiring staff (roles.staff or roles.develop)
 * or the owner account.
 *
 * Env: BLOB_READ_WRITE_TOKEN (the darkwood-node-files store).
 */

const PROJECT_ID = "gestr-lab";
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const OWNER_EMAIL = "kaalobmoran@gmail.com";
// Listing pages until this many blobs have been scanned, so one very large
// store can't make this endpoint hang.
const MAX_SCANNED = 5000;

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function claimsOf(idToken: string): { sub?: string; email?: string } {
  try {
    return JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

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

/** A rough category from the blob's path, matching api/upload.ts's folders. */
function categoryOf(pathname: string): string {
  if (pathname.startsWith("emoji/")) return "emoji";
  if (pathname.startsWith("banner/")) return "server banner";
  if (pathname.startsWith("profile/")) return "profile picture";
  if (pathname.startsWith("feedback/")) return "feedback";
  return "chat file";
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return send(res, 500, { error: "Blob storage is not set up on this server" });

  const auth = req.headers.authorization ?? "";
  const idToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!idToken) return send(res, 401, { error: "Log in first" });

  const claims = claimsOf(idToken);
  const uid = claims.sub ?? "";
  if (!uid) return send(res, 401, { error: "Log in first" });
  if (!(await isStaff(idToken, uid, String(claims.email ?? "")))) {
    return send(res, 403, { error: "Staff only" });
  }

  try {
    let cursor: string | undefined;
    let totalBytes = 0;
    let totalCount = 0;
    let scanned = false;
    const byCategory = new Map<string, { count: number; bytes: number }>();
    const recent: { pathname: string; url: string; size: number; uploadedAt: string; category: string }[] = [];

    do {
      const page = await list({ token, cursor, limit: 1000 });
      for (const b of page.blobs) {
        totalCount++;
        totalBytes += b.size;
        const category = categoryOf(b.pathname);
        const bucket = byCategory.get(category) ?? { count: 0, bytes: 0 };
        bucket.count++;
        bucket.bytes += b.size;
        byCategory.set(category, bucket);
        recent.push({ pathname: b.pathname, url: b.url, size: b.size, uploadedAt: b.uploadedAt as unknown as string, category });
      }
      cursor = page.cursor;
      scanned = !page.hasMore || totalCount >= MAX_SCANNED;
    } while (!scanned);

    recent.sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt));

    send(res, 200, {
      totalCount,
      totalBytes,
      capped: totalCount >= MAX_SCANNED,
      byCategory: [...byCategory.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.bytes - a.bytes),
      recent: recent.slice(0, 20),
    });
  } catch {
    send(res, 502, { error: "Could not reach storage. Try again." });
  }
}
