import { createVerify } from "node:crypto";
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
const CERTS = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const OWNER_EMAIL = "kaalobmoran@gmail.com";
let certCache: { at: number; keys: Record<string, string> } | null = null;

async function ownerSignedIn(idToken: string): Promise<boolean> {
  const parts = idToken.split(".");
  if (parts.length !== 3) return false;
  let header: { alg?: string; kid?: string };
  let payload: { aud?: string; iss?: string; exp?: number; email?: string };
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (header.alg !== "RS256" || !header.kid) return false;
  if (payload.aud !== PROJECT_ID || payload.iss !== `https://securetoken.google.com/${PROJECT_ID}`) return false;
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return false;
  if (String(payload.email ?? "").toLowerCase() !== OWNER_EMAIL) return false;
  if (!certCache || Date.now() - certCache.at > 60 * 60 * 1000) {
    const res = await fetch(CERTS);
    if (res.ok) certCache = { at: Date.now(), keys: (await res.json()) as Record<string, string> };
  }
  const pem = certCache?.keys[header.kid];
  if (!pem) return false;
  return createVerify("RSA-SHA256").update(`${parts[0]}.${parts[1]}`).verify(pem, Buffer.from(parts[2], "base64url"));
}
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
  // A missing member record is the owner. Firestore being out of reads is not a lost role.
  if (!res.ok) {
    if (res.status === 404 && owner) return true;
    if ((res.status === 429 || res.status === 503) && owner) return ownerSignedIn(idToken);
    return false;
  }
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
  if (!res.ok) {
    // On "bad key", say what kind of key it got (its first letters' type and
    // its length, never the key itself), so a wrong paste is easy to spot.
    const k = (headers.Authorization ?? "").replace(/^Bearer /, "");
    const kind = /^github_pat_/.test(k) ? "github_pat_" : /^gh[pousr]_/.test(k) ? k.slice(0, 4) : k ? "unknown kind" : "empty";
    throw new Error(`${who} answered ${res.status}${res.status === 401 ? ` (key: ${kind}, ${k.length} characters)` : ""}`);
  }
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

/**
 * Which AI helped with a commit, from its co-author lines, author and
 * message: Claude, Codex, Grok, Codebuff, or "by hand".
 */
export function whichAi(text: string) {
  const t = text.toLowerCase();
  if (/\bclaude\b|anthropic/.test(t)) return "Claude";
  if (/codex|openai|chatgpt|\bgpt-?\d/.test(t)) return "Codex";
  if (/\bgrok\b|x\.ai|\bxai\b/.test(t)) return "Grok";
  if (/codebuff/.test(t)) return "Codebuff";
  if (/copilot/.test(t)) return "Copilot";
  return "by hand";
}

// Which part of the app a changed file belongs to (first match wins).
const AREAS: [RegExp, string][] = [
  [/^src\/room\/|^room\.html$/, "Darkwood Room"],
  [/src\/ui\/(Chat|Emoji)/, "Chat"],
  [/src\/ui\/(VoiceRoom|CallStrip|LiveTile|WallView|RoomPane)/, "Videochat"],
  [/src\/data\/dms/, "DMs"],
  [/[Ff]eedback/, "Feedback"],
  [/activity|audit/, "Activity page"],
  [/^api\//, "Server (api)"],
  [/src\/ui\/Shell|app\.css|App\.tsx|Modal|styles\.css/, "App layout"],
  [/src\/data\//, "Data"],
  [/src\/auth|src\/firebase|access-client|Login/, "Login"],
  [/firestore\.rules/, "Database rules"],
  [/^admin\//, "Admin panel"],
  [/^public\//, "Pictures & files"],
  [/package(-lock)?\.json/, "Packages"],
  [/vite\.config|vercel\.json|tsconfig|\.gitignore/, "Setup"],
  [/\.md$/, "Docs"],
];
export function areaOf(path: string) {
  for (const [re, label] of AREAS) if (re.test(path)) return label;
  return path.includes("/") ? path.split("/")[0] : "Other";
}

// Commit details are fetched for the newest few per repo and kept: a commit never changes.
const CHANGED_COMMITS = 15;
const changeCache = new Map<string, { areas: string[]; files: number; added: number; removed: number }>();
async function changesOf(repo: string, sha: string) {
  const key = `${repo}@${sha}`;
  const known = changeCache.get(key);
  if (known) return known;
  try {
    const c = (await github(`repos/${repo}/commits/${sha}`)) as Gh;
    const files = (c.files ?? []) as Gh[];
    const areas = [...new Set(files.map((f) => areaOf(String(f.filename))))];
    const result = {
      areas,
      files: files.length,
      added: Number(c.stats?.additions ?? 0),
      removed: Number(c.stats?.deletions ?? 0),
    };
    changeCache.set(key, result);
    return result;
  } catch {
    return null;
  }
}

export async function repoActivity(p: (typeof PROJECTS)[number]) {
  try {
    const [commits, events, pulls] = await Promise.all([
      github(`repos/${p.repo}/commits?per_page=40`) as Promise<Gh[]>,
      github(`repos/${p.repo}/events?per_page=60`) as Promise<Gh[]>,
      github(`repos/${p.repo}/pulls?state=all&per_page=20`) as Promise<Gh[]>,
    ]);
    // what the newest commits changed (a commit never changes, so each is asked once)
    const changes = await Promise.all(commits.slice(0, CHANGED_COMMITS).map((c) => changesOf(p.repo, String(c.sha))));
    return {
      name: p.name,
      repo: p.repo,
      commits: commits.map((c, i) => {
        const msg = String(c.commit?.message ?? "");
        // AI helpers sign their commits; show who wrote it with whom
        const helpers = [...msg.matchAll(/Co-Authored-By:\s*([^<\n]+)</gi)].map((m) => m[1].trim());
        const author = c.author?.login ?? c.commit?.author?.name ?? "unknown";
        return {
          sha: String(c.sha).slice(0, 7),
          url: c.html_url,
          title: msg.split("\n")[0].slice(0, 200),
          author,
          avatar: c.author?.avatar_url ?? "",
          helpers,
          ai: whichAi([...helpers, author, c.commit?.author?.name ?? "", c.commit?.author?.email ?? "", msg].join(" ")),
          change: changes[i] ?? null,
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

// ---- the Commit & Deploy Lane (COMMIT-DEPLOY-LANE.md) ----------------------
// Read live from the lane issue's comments: who holds the lane (Entering /
// Lane held), who is waiting (Waiting for lane:), and the last release.
const LANE = { repo: "devarim28supply-afk/Digital-House-App", issue: 1 };
const LANE_CACHE_MS = 15_000;
let laneCache: { at: number; body: unknown } | null = null;

type LaneTurn = { who: string; agent: string; what: string; since: string; url: string };
export function readLane(comments: Gh[]) {
  let holder: LaneTurn | null = null;
  let queue: LaneTurn[] = [];
  let lastRelease: { who: string; agent: string; note: string; at: string } | null = null;
  let urgent: { who: string; at: string } | null = null;
  for (const c of comments) {
    const text = String(c.body ?? "").trim();
    const who = c.user?.login ?? "unknown";
    const at = c.created_at;
    const agentOf = (fallback: string) => {
      const ai = whichAi(text);
      return ai === "by hand" ? fallback : ai;
    };
    const lines = text.split("\n").map((l) => l.trim());
    const has = (re: RegExp) => lines.some((l) => re.test(l.replace(/^[>*_\s"“]+/, "")));
    if (has(/^Lane released/i)) {
      holder = null;
      urgent = null;
      lastRelease = { who, agent: agentOf(""), note: lines.filter((l) => l && !/^Lane released/i.test(l)).join(" ").slice(0, 200), at };
      queue = queue.filter((q) => q.who !== who);
      continue;
    }
    if (has(/^Entering Commit (&|and) Deploy Lane/i) || has(/^Lane held/i)) {
      const held = lines.find((l) => /Lane held/i.test(l)) ?? "";
      // the same person posting again keeps their start time and earlier details
      const prev = holder as LaneTurn | null;
      const same = prev?.who === who ? prev : null;
      const what: string = held.match(/Working on (.+?)(\. Do not push|$)/i)?.[1] ?? same?.what ?? "";
      holder = { who, agent: agentOf(same?.agent ?? ""), what, since: same?.since ?? at, url: c.html_url };
      queue = queue.filter((q) => q.who !== who);
      continue;
    }
    const waiting = lines.find((l) => /^Waiting for lane:?/i.test(l.replace(/^[>*_\s"“]+/, "")));
    if (waiting && !queue.some((q) => q.who === who) && holder?.who !== who) {
      queue.push({ who, agent: agentOf(""), what: waiting.replace(/^.*Waiting for lane:?\s*/i, "").replace(/\.$/, ""), since: at, url: c.html_url });
      continue;
    }
    if (has(/^Requesting lane release/i)) urgent = { who, at };
  }
  return { holder, queue, lastRelease, urgent };
}

async function laneNow() {
  try {
    const issue = (await github(`repos/${LANE.repo}/issues/${LANE.issue}`)) as Gh;
    // the newest comments: the last page of 100
    const lastPage = Math.max(1, Math.ceil(Number(issue.comments ?? 0) / 100));
    const comments = (await github(`repos/${LANE.repo}/issues/${LANE.issue}/comments?per_page=100&page=${lastPage}`)) as Gh[];
    return { url: issue.html_url, repo: LANE.repo, ...readLane(comments) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "failed";
    return {
      url: `https://github.com/${LANE.repo}/issues/${LANE.issue}`,
      repo: LANE.repo,
      error: /40[34]/.test(msg) ? `${msg}: the GitHub key needs "Issues: Read"` : msg,
    };
  }
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET") return send(res, 405, { error: "Use GET" });
  const laneOnly = new URL(req.url ?? "/", "http://local").searchParams.has("lane");
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
  // the lane alone, fresher (every 15 s): ?lane
  if (laneOnly) {
    if (!laneCache || Date.now() - laneCache.at > LANE_CACHE_MS) laneCache = { at: Date.now(), body: await laneNow() };
    return send(res, 200, laneCache.body);
  }
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    const [repos, deployList] = await Promise.all([Promise.all(PROJECTS.map(repoActivity)), deploys()]);
    cache = { at: Date.now(), body: { at: new Date().toISOString(), repos, deploys: deployList } };
  }
  send(res, 200, cache.body);
}
