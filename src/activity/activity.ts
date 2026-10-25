// The Activity page (activity.html): who committed, pushed, deployed and
// opened pull requests, across Darkwood Node's projects. Staff only; the data
// comes from /api/activity (GitHub + Vercel, read-only), refreshed every minute.

import { onAuthStateChanged } from "firebase/auth";

import { auth } from "../firebase";

type Commit = { sha: string; url: string; title: string; author: string; avatar: string; helpers: string[]; at: string };
type Push = { by: string; avatar: string; branch: string; count: number; head: string; at: string };
type Pull = { number: number; title: string; url: string; by: string; state: string; mergedBy: string; at: string };
type Repo = { name: string; repo: string; commits: Commit[]; pushes: Push[]; pulls: Pull[]; error?: string };
type Deploy = { project: string; url: string; state: string; target: string; by: string; commit: string; message: string; via: string; at: string; error?: string };
type Activity = { at: string; repos: Repo[]; deploys: Deploy[] };

type Kind = "commit" | "push" | "deploy" | "pr";
type Event = { kind: Kind; project: string; who: string; avatar: string; title: string; url: string; meta: string; at: number; state?: string };

const $ = (id: string) => document.getElementById(id)!;
const REFRESH_MS = 60_000;
const PAGE = 60;

let data: Activity | null = null;
let project = "all";
let kinds = new Set<Kind>(["commit", "push", "deploy", "pr"]);
let shown = PAGE;

function ago(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" }) + " " + new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function events(d: Activity): Event[] {
  const out: Event[] = [];
  for (const r of d.repos) {
    for (const c of r.commits) {
      out.push({
        kind: "commit",
        project: r.name,
        who: c.author,
        avatar: c.avatar,
        title: c.title,
        url: c.url,
        meta: `${c.sha}${c.helpers.length ? ` · with ${c.helpers.join(", ")}` : ""}`,
        at: Date.parse(c.at),
      });
    }
    for (const p of r.pushes) {
      out.push({
        kind: "push",
        project: r.name,
        who: p.by,
        avatar: p.avatar,
        // GitHub stopped saying how many commits a push had: show it only when known
        title: p.count ? `pushed ${p.count} commit${p.count === 1 ? "" : "s"} to ${p.branch}` : `pushed to ${p.branch}`,
        url: `https://github.com/${r.repo}/commit/${p.head}`,
        meta: p.head,
        at: Date.parse(p.at),
      });
    }
    for (const pr of r.pulls) {
      out.push({
        kind: "pr",
        project: r.name,
        who: pr.by,
        avatar: `https://github.com/${pr.by}.png?size=72`,
        title: `#${pr.number} ${pr.title}`,
        url: pr.url,
        meta: pr.state === "merged" ? `merged${pr.mergedBy ? ` by ${pr.mergedBy}` : ""}` : pr.state,
        at: Date.parse(pr.at),
      });
    }
  }
  for (const dep of d.deploys) {
    if (dep.error) continue;
    out.push({
      kind: "deploy",
      project: dep.project,
      who: dep.by,
      avatar: "",
      title: dep.commit ? `deployed ${dep.commit} ${dep.message}` : `deployed (${dep.via})`,
      url: dep.url,
      meta: dep.target,
      state: dep.state,
      at: Date.parse(dep.at),
    });
  }
  return out.filter((e) => !Number.isNaN(e.at)).sort((a, b) => b.at - a.at);
}

function button(label: string, pressed: boolean, onClick: () => void) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.setAttribute("aria-pressed", String(pressed));
  b.addEventListener("click", onClick);
  return b;
}

function render() {
  if (!data) return;
  const all = events(data);
  const projects = ["all", ...data.repos.map((r) => r.name)];
  $("projects").replaceChildren(
    ...projects.map((p) => button(p === "all" ? "All projects" : p, project === p, () => { project = p; shown = PAGE; render(); })),
  );
  const KIND_LABEL: Record<Kind, string> = { commit: "Commits", push: "Pushes", deploy: "Deploys", pr: "Pull requests" };
  $("kinds").replaceChildren(
    ...(Object.keys(KIND_LABEL) as Kind[]).map((k) =>
      button(KIND_LABEL[k], kinds.has(k), () => {
        if (kinds.has(k)) kinds.delete(k);
        else kinds.add(k);
        shown = PAGE;
        render();
      }),
    ),
  );
  const picked = all.filter((e) => (project === "all" || e.project === project) && kinds.has(e.kind));

  // who did what, last 30 days
  const since = Date.now() - 30 * 86400_000;
  const tally = new Map<string, { avatar: string; commit: number; push: number; deploy: number; pr: number; last: number }>();
  for (const e of all.filter((x) => x.at >= since && (project === "all" || x.project === project))) {
    const t = tally.get(e.who) ?? { avatar: "", commit: 0, push: 0, deploy: 0, pr: 0, last: 0 };
    t[e.kind]++;
    t.avatar ||= e.avatar;
    t.last = Math.max(t.last, e.at);
    tally.set(e.who, t);
  }
  $("people").replaceChildren(
    ...[...tally.entries()]
      .sort((a, b) => b[1].commit + b[1].deploy - (a[1].commit + a[1].deploy))
      .map(([who, t]) => {
        const el = document.createElement("div");
        el.className = "person";
        const img = document.createElement("img");
        img.alt = "";
        img.src = t.avatar || `https://github.com/${encodeURIComponent(who)}.png?size=72`;
        img.onerror = () => (img.style.visibility = "hidden");
        const text = document.createElement("div");
        const name = document.createElement("b");
        name.textContent = who;
        const line = document.createElement("small");
        line.textContent = `${t.commit} commits · ${t.push} pushes · ${t.deploy} deploys · ${t.pr} PRs`;
        const last = document.createElement("small");
        last.textContent = ` · last ${ago(t.last)}`;
        text.append(name, line, document.createElement("br"), last);
        el.append(img, text);
        return el;
      }),
  );

  $("feed").replaceChildren(
    ...picked.slice(0, shown).map((e) => {
      const row = document.createElement("div");
      row.className = "ev";
      const img = document.createElement("img");
      img.alt = "";
      img.src = e.avatar || `https://github.com/${encodeURIComponent(e.who)}.png?size=72`;
      img.onerror = () => (img.style.visibility = "hidden");
      const what = document.createElement("div");
      what.className = "what";
      const line1 = document.createElement("div");
      line1.className = "line1";
      const tag = document.createElement("span");
      tag.className = `tag ${e.kind}`;
      tag.textContent = e.kind === "pr" ? "PR" : e.kind;
      const who = document.createElement("b");
      who.textContent = e.who;
      const proj = document.createElement("span");
      proj.className = "proj";
      proj.textContent = e.project;
      line1.append(tag, who, proj);
      if (e.state) {
        const st = document.createElement("span");
        st.className = `state ${e.state}`;
        st.textContent = e.state.toLowerCase();
        line1.append(st);
      }
      const title = document.createElement(e.url ? "a" : "span");
      title.className = "title";
      title.textContent = e.title;
      if (e.url && title instanceof HTMLAnchorElement) {
        title.href = e.url;
        title.target = "_blank";
        title.rel = "noopener";
      }
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = e.meta;
      what.append(line1, title, meta);
      const time = document.createElement("time");
      time.textContent = ago(e.at);
      time.title = new Date(e.at).toLocaleString();
      row.append(img, what, time);
      return row;
    }),
  );
  if (!picked.length) $("feed").textContent = "Nothing here yet.";
  const more = $("more") as HTMLButtonElement;
  more.hidden = picked.length <= shown;
  more.onclick = () => { shown += PAGE; render(); };

  const errors = data.repos.filter((r) => r.error).map((r) => `${r.name}: ${r.error}`);
  $("updated").textContent = `updated ${ago(Date.parse(data.at))}${errors.length ? ` · ${errors.join("; ")}` : ""}`;
}

async function load() {
  const user = auth.currentUser;
  if (!user) return;
  try {
    const res = await fetch("/api/activity", { headers: { Authorization: `Bearer ${await user.getIdToken()}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
    data = body as Activity;
    $("status").hidden = true;
    $("content").hidden = false;
    render();
  } catch (err) {
    $("status").hidden = false;
    $("status").className = "msg err";
    $("status").textContent = err instanceof Error ? err.message : "Could not load the activity.";
  }
}

let started = false;
onAuthStateChanged(auth, (user) => {
  if (!user) {
    $("status").textContent = "Log in to Darkwood Node first (owner, admins and developers only).";
    return;
  }
  if (started) return;
  started = true;
  void load();
  window.setInterval(() => void load(), REFRESH_MS);
  window.setInterval(render, 30_000); // keep "x min ago" fresh between loads
});
