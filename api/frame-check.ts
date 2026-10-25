import { lookup } from "node:dns/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";

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

/** An address on the public internet (not this machine, a private network or a reserved range). */
export function publicAddress(ip: string) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return publicAddress(v6.slice(7));
  return !(v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff"));
}

/** A link this server may fetch: https, and every address its name has is public. */
async function safeTarget(url: URL) {
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, ""); // an IPv6 address comes in [brackets]
  if (/^localhost$/i.test(host) || /\.(local|internal|localhost)$/i.test(host)) return false;
  if (isIP(host)) return publicAddress(host);
  try {
    const addresses = await lookup(host, { all: true });
    return addresses.length > 0 && addresses.every((a) => publicAddress(a.address));
  } catch {
    return false;
  }
}

const MAX_REDIRECTS = 5;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const raw = new URL(req.url ?? "/", "http://local").searchParams.get("url") ?? "";
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return send(res, 400, { error: "Bad link" });
  }
  // public web pages only: never this machine or a private network. Every
  // redirect is checked the same way before it is followed.
  if (!(await safeTarget(target))) return send(res, 400, { error: "Public https links only" });
  try {
    for (let hop = 0; ; hop++) {
      const page = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(6000) });
      const next = page.headers.get("location");
      if (page.status >= 300 && page.status < 400 && next) {
        if (hop >= MAX_REDIRECTS) return send(res, 200, { embeddable: true });
        target = new URL(next, target);
        if (!(await safeTarget(target))) return send(res, 400, { error: "Public https links only" });
        continue;
      }
      return send(res, 200, { embeddable: embeddable(page.headers) });
    }
  } catch {
    // could not reach it: let the frame try
    send(res, 200, { embeddable: true });
  }
}
