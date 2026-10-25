import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Who did what across Darkwood Node's projects, for the Activity page.
 *
 *   GET /api/activity   Authorization: Bearer <Firebase ID token>
 *   → { at, repos: [{ repo, commits, pushes, pulls }], deploys: [...] }
 *
 * Staff only: the owner, admins, and members with the "develop" role (set in
 * the M2A-access admin panel). Firestore itself confirms the caller: their
 * members/{uid} record is read with their own token (the owner has none:
 * Firestore's 404 to a genuine token).
 *
 * Env (read-only keys, only on the server, never sent to the browser):
 *   GITHUB_TOKEN   fine-grained, the four repos below: Contents, Pull requests, Metadata: read
 *   VERCEL_TOKEN   a Vercel token for the Devarim 28 Supply Co team
 */

const PROJECT_ID = "gestr-lab";
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const OWNER_EMAIL = "kaalobmoran@gmail.com";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VERCEL_TEAM = "team_PUGYiYbFC2XneUsiLOCykO73";

// What it tracks: each repo, and its Vercel project (if it deploys)
const PROJECTS = [
  { name: "Darkwood Node app", repo: "devarim28supply-afk/Digital-House-App", vercel: "prj_rrMY8QSKG5uOHcLItLdg9VrnYuat" },
  { name: "Database rules", repo: "devarim28supply-afk/M2A-Access-Control", vercel: "" },
  { name: "M2A-access bunker", repo: "devarim28supply-afk/M2A-access", vercel: "prj_onQqeCIuWtFs8MPYSadkMqc7NqiV" },
  { name: "Living Room", repo: "devarim28supply-afk/Gestr-LivingRoom", vercel: "prj_F7m9Quqo0w8GtQyFai8useAHT54n" },
];

// GitHub and Vercel are asked at most once a minute, however many people look.
const CACHE_MS = 60_000;
let cache: { at: number; body: unknown } | null = null;

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

/** Owner, admin or developer; anything unclear fails closed. */
async function isStaff(idToken: string) {
  const claims = claimsOf(idToken);
  const uid = claims.sub ?? "";
  if (!idToken || !ID_RE.test(uid)) return false;
  const res = await fetch(`${FIRESTORE}/members/${uid}`, { headers: { Authorization: `Bearer ${idToken}` } });
  const owner = String(claims.email ?? "").toLowerCase() === OWNER_EMAIL;
  if (!res.ok) return owner && res.status === 404;
  if (owner) return true;
  const data = (await res.json()) as {
    fields?: {
      status?: { stringValue?: string };
      roles?: { mapValue?: { fields?: Record<string, { booleanValue?: boolean }> } };
    };
  };
  if (data.fields?.status?.stringValue !== "approved") return false;
  const roles = data.fields?.roles?.mapValue?.fields ?? {};
  return roles.admin?.booleanValue === true || roles.develop?.booleanValue === true;
}

/**
 * A key from the environment: just the key itself, whatever was pasted
 * around it. Keys never contain spaces, so the first word is the key.
 */
const key = (raw: string | undefined) => (raw ?? "").trim().split(/\s+/)[0] ?? "";

/**
 * One request. A failure is reported only as a short fixed message: never
 * the request or its error text, which can echo the key back.
 */
async function call(url: string, headers: Record<string, string>, who: string) {
  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch {
    throw new Error(`${who} could not be reached (check its key)`);
  }
  if (!res.ok) throw new Error(`${who} answered ${res.status}`);
  return res.json();
}

const github = (path: string) =>
  call(
    `https://api.github.com/${path}`,
    {
      Authorization: `Bearer ${key(process.env.GITHUB_TOKEN)}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "darkwood-node-activity",
    },
    "GitHub",
  );

const vercel = (path: string) =>
  call(`https://api.vercel.com/${path}`, { Authorization: `Bearer ${key(process.env.VERCEL_TOKEN)}` }, "Vercel");

type Gh = Record<string, any>; // GitHub / Vercel replies, read loosely

export async function repoActivity(p: (typeof PROJECTS)[number]) {
  try {
    const [commits, events, pulls] = await Promise.all([
      github(`repos/${p.repo}/commits?per_page=40`) as Promise<Gh[]>,
      github(`repos/${p.repo}/events?per_page=60`) as Promise<Gh[]>,
      github(`repos/${p.repo}/pulls?state=all&per_page=20`) as Promise<Gh[]>,
    ]);
    return {
      name: p.name,
      repo: p.repo,
      commits: commits.map((c) => {
        const msg = String(c.commit?.message ?? "");
        // AI helpers sign their commits; show who wrote it with whom
        const helpers = [...msg.matchAll(/Co-Authored-By:\s*([^<\n]+)</gi)].map((m) => m[1].trim());
        return {
          sha: String(c.sha).slice(0, 7),
          url: c.html_url,
          title: msg.split("\n")[0].slice(0, 200),
          author: c.author?.login ?? c.commit?.author?.name ?? "unknown",
          avatar: c.author?.avatar_url ?? "",
          helpers,
          at: c.commit?.author?.date ?? c.commit?.committer?.date,
        };
      }),
      pushes: events
        .filter((e) => e.type === "PushEvent")
        .map((e) => ({
          by: e.actor?.login ?? "unknown",
          avatar: e.actor?.avatar_url ?? "",
          branch: String(e.payload?.ref ?? "").replace("refs/heads/", ""),
          count: e.payload?.size ?? e.payload?.commits?.length ?? 0,
          head: String(e.payload?.head ?? "").slice(0, 7),
          at: e.created_at,
        })),
      pulls: pulls.map((pr) => ({
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        by: pr.user?.login ?? "unknown",
        state: pr.merged_at ? "merged" : pr.state,
        mergedBy: pr.merged_by?.login ?? "",
        at: pr.merged_at ?? pr.closed_at ?? pr.created_at,
      })),
    };
  } catch (err) {
    return { name: p.name, repo: p.repo, commits: [], pushes: [], pulls: [], error: err instanceof Error ? err.message : "failed" };
  }
}

async function deploys() {
  const all = await Promise.all(
    PROJECTS.filter((p) => p.vercel).map(async (p) => {
      try {
        const body = (await vercel(`v6/deployments?projectId=${p.vercel}&teamId=${VERCEL_TEAM}&limit=25`)) as { deployments?: Gh[] };
        return (body.deployments ?? []).map((d) => ({
          project: p.name,
          url: d.url ? `https://${d.url}` : "",
          state: d.state ?? d.readyState,
          target: d.target ?? "preview",
          by: d.creator?.username ?? d.creator?.email ?? "unknown",
          commit: d.meta?.githubCommitSha ? String(d.meta.githubCommitSha).slice(0, 7) : "",
          message: d.meta?.githubCommitMessage ? String(d.meta.githubCommitMessage).split("\n")[0] : "",
          via: d.meta?.githubCommitSha ? "git" : d.source ?? "cli",
          at: new Date(d.created ?? d.createdAt).toISOString(),
        }));
      } catch {
        return [{ project: p.name, error: "Could not read deploys" }];
      }
    }),
  );
  return all.flat();
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET") return send(res, 405, { error: "Use GET" });
  const auth = req.headers.authorization ?? "";
  const idToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try {
    if (!(await isStaff(idToken))) return send(res, 403, { error: "Owner, admins and developers only" });
  } catch {
    return send(res, 403, { error: "Owner, admins and developers only" });
  }
  if (!process.env.GITHUB_TOKEN || !process.env.VERCEL_TOKEN) {
    return send(res, 500, { error: "The read-only GitHub and Vercel keys are not set up yet (GITHUB_TOKEN, VERCEL_TOKEN)." });
  }
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    const [repos, deployList] = await Promise.all([Promise.all(PROJECTS.map(repoActivity)), deploys()]);
    cache = { at: Date.now(), body: { at: new Date().toISOString(), repos, deploys: deployList } };
  }
  send(res, 200, cache.body);
}
