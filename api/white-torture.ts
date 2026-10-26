import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The White Torture page, served from this site so it can play inside a tile.
 *
 *   GET /api/white-torture
 *
 * The game's own site sends X-Frame-Options: DENY, so a Room iframe of that
 * address stays blank. This returns the same page with a base address on the
 * game's site (its scripts, pictures and sounds load from there) and framing
 * allowed only for Digital House. The Room side then shows it with the call's
 * webcams underneath.
 */

const GAME_ORIGIN = "https://rimyshrimp-white-torture-br.vercel.app";
const FRAME_ANCESTORS = "frame-ancestors 'self' https://darkwood-node.vercel.app http://localhost:5186";
const MAX_HTML = 1_000_000;

/** Let the game's own files load, and let Digital House frame this copy. */
export function playablePolicy(csp: string, localhost: boolean) {
  const next = csp
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const [name, ...rest] = part.split(/\s+/);
      const key = name.toLowerCase();
      if (key === "frame-ancestors") return [FRAME_ANCESTORS];
      if (key === "base-uri") return [`base-uri ${GAME_ORIGIN}`];
      if (key === "upgrade-insecure-requests" && localhost) return [];
      if (rest.includes("'self'")) return [`${name} ${rest.join(" ")} ${GAME_ORIGIN}`];
      return [part];
    });
  return next.join("; ");
}

function send(res: ServerResponse, status: number, body: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return send(res, 405, "GET only");
  }
  const host = String(req.headers.host ?? "");
  const localhost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  let upstream: Response;
  try {
    upstream = await fetch(`${GAME_ORIGIN}/`, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "DarkwoodNode" },
    });
  } catch {
    return send(res, 502, "White Torture could not be reached.");
  }
  if (!upstream.ok || new URL(upstream.url).origin !== GAME_ORIGIN) {
    return send(res, 502, "White Torture could not be reached.");
  }
  const html = await upstream.text();
  if (html.length > MAX_HTML) return send(res, 502, "White Torture could not be reached.");
  const page = html.replace(/<head([^>]*)>/i, `<head$1><base href="${GAME_ORIGIN}/">`);
  const csp = upstream.headers.get("content-security-policy");
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (csp) res.setHeader("Content-Security-Policy", playablePolicy(csp, localhost));
  res.end(req.method === "HEAD" ? undefined : page);
}
