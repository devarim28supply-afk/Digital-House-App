import { type LookupAddress, lookup as dnsLookup } from "node:dns";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request } from "node:https";
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
 *
 * The server only ever connects to the public internet: the address is
 * checked as the connection is made (the very address it connects to, so a
 * name cannot point somewhere else between a check and the connection), and
 * again for every redirect.
 */

const OUR_ORIGINS = ["https://darkwood-node.vercel.app", "http://localhost:5186"];
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 6000;

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

export function embeddable(headers: { get(name: string): string | null }) {
  const xfo = (headers.get("x-frame-options") ?? "").toLowerCase();
  if (xfo.includes("deny") || xfo.includes("sameorigin")) return false;
  const ancestors = frameAncestors(headers.get("content-security-policy") ?? "");
  if (!ancestors) return true;
  if (ancestors.includes("*")) return true;
  if (ancestors.includes("'none'")) return false;
  return OUR_ORIGINS.some((origin) => ancestors.some((a) => a === origin || a === "https:"));
}

/** The 8 groups of an IPv6 address (a dotted IPv4 tail becomes 2 groups), or null. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const [a, b, c, d] = tail[1].split(".").map(Number);
    text = text.slice(0, -tail[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/** An address on the public internet (not this machine, a private network or a reserved range). */
export function publicAddress(ip: string) {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split(".").map(Number);
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (kind !== 6) return false;
  const g = ipv6Groups(ip);
  if (!g) return false;
  // IPv6: only real public internet addresses (2000::/3), which rules out
  // every way of writing a local or private IPv4 address inside IPv6
  // (::ffff:…, ::…, 64:ff9b::…). Within it, also refuse 6to4 (2002::/16,
  // carries an IPv4 address), Teredo (2001::/32) and documentation (2001:db8::/32).
  if (g[0] < 0x2000 || g[0] > 0x3fff) return false;
  if (g[0] === 0x2002) return false;
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return false;
  return true;
}

/**
 * The name lookup the connection itself uses: it hands the connection only
 * addresses that passed the check, so the server never connects anywhere else.
 */
function publicLookup(
  host: string,
  options: { all?: boolean },
  cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) {
  dnsLookup(host, { all: true }, (err, addresses) => {
    if (err) return cb(err, "");
    const list = addresses as LookupAddress[];
    if (!list.length || !list.every((a) => publicAddress(a.address))) {
      return cb(Object.assign(new Error("Not a public address"), { code: "ENOTPUBLIC" }), "");
    }
    if (options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

/** A link this server may try: https, no login in it, not a local name or address. */
function allowedUrl(url: URL) {
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, ""); // an IPv6 address comes in [brackets]
  if (/^localhost$/i.test(host) || /\.(local|internal|localhost)$/i.test(host)) return false;
  if (isIP(host)) return publicAddress(host);
  return true; // a name: its addresses are checked as the connection is made
}

/** One request, headers only (the page itself is never read), no redirects followed. */
function headersOf(url: URL): Promise<{ status: number; headers: { get(name: string): string | null } }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "GET", lookup: publicLookup as never, timeout: TIMEOUT_MS, headers: { "User-Agent": "DarkwoodNode-FrameCheck" } },
      (res) => {
        const raw = res.headers;
        res.destroy();
        resolve({
          status: res.statusCode ?? 0,
          headers: {
            get: (name: string) => {
              const v = raw[name.toLowerCase()];
              return v === undefined ? null : Array.isArray(v) ? v.join(", ") : String(v);
            },
          },
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

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
  if (!allowedUrl(target)) return send(res, 400, { error: "Public https links only" });
  try {
    for (let hop = 0; ; hop++) {
      const page = await headersOf(target);
      const next = page.headers.get("location");
      if (page.status >= 300 && page.status < 400 && next) {
        if (hop >= MAX_REDIRECTS) return send(res, 200, { embeddable: true });
        target = new URL(next, target);
        if (!allowedUrl(target)) return send(res, 400, { error: "Public https links only" });
        continue;
      }
      return send(res, 200, { embeddable: embeddable(page.headers) });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOTPUBLIC") return send(res, 400, { error: "Public https links only" });
    // could not reach it: let the frame try
    send(res, 200, { embeddable: true });
  }
}
