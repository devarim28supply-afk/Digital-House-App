import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Can this page be shown inside Darkwood Node (a tile's Room side)?
 *
 *   GET /api/frame-check?url=https://…   →  { embeddable: boolean }
 *
 * The browser cannot tell (a refused frame just stays empty), so the server
 * reads the page's own rules: X-Frame-Options DENY / SAMEORIGIN, or a
 * Content-Security-Policy frame-ancestors that does not name this site. A
 * page that refuses gets an "Open it in its own tab" button instead.
 */

const OUR_ORIGINS = ["https://darkwood-node.vercel.app", "http://localhost:5186"];

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  // a site's rules rarely change: ask again after an hour
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.end(JSON.stringify(body));
}

/** frame-ancestors from a CSP header, or undefined when it has none. */
function frameAncestors(csp: string) {
  const rule = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.toLowerCase().startsWith("frame-ancestors"));
  return rule ? rule.split(/\s+/).slice(1) : undefined;
}

export function embeddable(headers: Headers) {
  const xfo = (headers.get("x-frame-options") ?? "").toLowerCase();
  if (xfo.includes("deny") || xfo.includes("sameorigin")) return false;
  const ancestors = frameAncestors(headers.get("content-security-policy") ?? "");
  if (!ancestors) return true;
  if (ancestors.includes("*")) return true;
  if (ancestors.includes("'none'")) return false;
  return OUR_ORIGINS.some((origin) => ancestors.some((a) => a === origin || a === "https:"));
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const raw = new URL(req.url ?? "/", "http://local").searchParams.get("url") ?? "";
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return send(res, 400, { error: "Bad link" });
  }
  // public web pages only: never this machine or a private network
  const host = target.hostname;
  if (
    target.protocol !== "https:" ||
    /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/.test(host) ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return send(res, 400, { error: "Public https links only" });
  }
  try {
    const page = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(6000) });
    send(res, 200, { embeddable: embeddable(page.headers) });
  } catch {
    // could not reach it: let the frame try
    send(res, 200, { embeddable: true });
  }
}
