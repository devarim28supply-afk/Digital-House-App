// The Activity page (activity.html): who did what across Darkwood Node.
//
// - Commits, pushes, deploys and pull requests from /api/activity (GitHub +
//   Vercel, read-only), with which AI helped and which parts each commit changed.
// - Actions inside Darkwood Node from the action log (auditlog, data/audit.ts).
// - Real people instead of account names: activity_people lists each person's
//   GitHub and Vercel accounts and their Darkwood account (owner/admins edit).
//
// Staff only (owner, admins, developers). Refreshed every minute.

import { onAuthStateChanged } from "firebase/auth";
import { collection, deleteDoc, doc, getDoc, onSnapshot, setDoc } from "firebase/firestore";

import { type AuditEntry, watchAudit } from "../data/audit";
import { auth, db } from "../firebase";

type Change = { areas: string[]; files: number; added: number; removed: number } | null;
type Commit = { sha: string; url: string; title: string; author: string; avatar: string; helpers: string[]; ai: string; change: Change; at: string };
type Push = { by: string; avatar: string; branch: string; count: number; head: string; at: string };
type Pull = { number: number; title: string; url: string; by: string; state: string; mergedBy: string; at: string };
type Repo = { name: string; repo: string; commits: Commit[]; pushes: Push[]; pulls: Pull[]; error?: string };
type Deploy = { project: string; url: string; state: string; target: string; by: string; commit: string; message: string; via: string; at: string; error?: string };
type Activity = { at: string; repos: Repo[]; deploys: Deploy[] };

type Kind = "commit" | "push" | "deploy" | "pr" | "action";
type Event = {
  kind: Kind;
  project: string;
  account: string; // the GitHub / Vercel / Darkwood account that did it
  avatar: string;
  title: string;
  url: string;
  meta: string;
  at: number;
  state?: string;
  ai?: string;
  change?: Change;
};

/** A real person and the accounts that are theirs. */
type Person = { id: string; name: string; uid: string; github: string[]; vercel: string[] };
type Profile = { name?: string; username?: string; photo?: string; color?: string };

const $ = (id: string) => document.getElementById(id)!;
const REFRESH_MS = 60_000;
const PAGE = 60;
const KIND_LABEL: Record<Kind, string> = { commit: "Commits", push: "Pushes", deploy: "Deploys", pr: "Pull requests", action: "Darkwood actions" };

let data: Activity | null = null;
let actions: AuditEntry[] = [];
let actionsError = "";
let people: Person[] = [];
const profiles = new Map<string, Profile>();
const serverNames = new Map<string, string>();
let project = "all";
const kinds = new Set<Kind>(["commit", "push", "deploy", "pr", "action"]);
let shown = PAGE;

// ---- who is who --------------------------------------------------------------
const lower = (s: string) => s.toLowerCase();
function personOf(kind: Kind, account: string): Person | undefined {
  const a = lower(account);
  return people.find((p) =>
    kind === "action"
      ? p.uid === account
      : kind === "deploy"
        ? p.vercel.some((v) => lower(v) === a)
        : p.github.some((g) => lower(g) === a),
  );
}
function profileName(uid: string) {
  const p = profiles.get(uid);
  return p?.name || p?.username || "someone";
}
/** The name to show for whoever did an event. */
function whoOf(e: Event) {
  const person = personOf(e.kind, e.account);
  if (person) return person.name;
  return e.kind === "action" ? profileName(e.account) : e.account;
}
function photoOf(e: Event) {
  const person = personOf(e.kind, e.account);
  const uid = person?.uid || (e.kind === "action" ? e.account : "");
  return profiles.get(uid)?.photo || e.avatar || (e.kind !== "action" ? `https://github.com/${encodeURIComponent(e.account)}.png?size=72` : "");
}
async function loadProfile(uid: string) {
  if (!uid || profiles.has(uid)) return;
  profiles.set(uid, {});
  try {
    const snap = await getDoc(doc(db, "profiles", uid));
    if (snap.exists()) profiles.set(uid, snap.data() as Profile);
    render();
  } catch {
    /* a name we cannot read stays "someone" */
  }
}
async function loadServerName(sid: string) {
  if (!sid || serverNames.has(sid)) return;
  serverNames.set(sid, "");
  try {
    const snap = await getDoc(doc(db, "servers", sid));
    const s = snap.data();
    if (s) serverNames.set(sid, s.kind === "dm" ? "a DM" : String(s.name ?? ""));
    render();
  } catch {
    /* not a member of it: no name */
  }
}

// ---- what happened -------------------------------------------------------------
const ACTION_TEXT: Record<string, (e: AuditEntry) => string> = {
  "server.create": (e) => `made the server ${e.target ?? ""}`,
  "server.delete": () => "deleted a server",
  "server.settings": (e) => `changed server settings (${e.detail ?? ""})`,
  "server.rename": (e) => `renamed the server to ${e.target ?? ""}`,
  "server.open": (e) => `set the server ${e.detail ?? ""}`,
  "member.add": (e) => `added ${(e.target ?? "").split(",").map(profileName).join(", ")} to the server`,
  "member.remove": (e) => `removed ${profileName(e.target ?? "")} from the server`,
  "member.approve": (e) => `approved ${profileName(e.target ?? "")}`,
  "member.deny": (e) => `revoked ${profileName(e.target ?? "")}`,
  "member.roles": (e) => `changed ${profileName(e.target ?? "")}'s role (${e.detail ?? ""})`,
  "tile.create": (e) => `made the tile ${e.target ?? ""}`,
  "tile.delete": (e) => `deleted the tile ${e.target ?? ""}`,
  "tile.picture": (e) => `changed the picture of ${e.target ?? ""}`,
  "channel.create": (e) => `made the ${e.detail ?? ""} channel ${e.target ?? ""}`,
  "channel.rename": (e) => `renamed a channel to ${e.target ?? ""}`,
  "message.delete": (e) => `deleted ${profileName(e.target ?? "")}'s message (${e.detail ?? ""})`,
  "emoji.add": (e) => `added the ${e.detail ?? "emoji"} ${e.target ?? ""}`,
  "emoji.delete": (e) => `removed the emoji ${e.target ?? ""}`,
};

function events(): Event[] {
  const out: Event[] = [];
  for (const r of data?.repos ?? []) {
    for (const c of r.commits) {
      out.push({
        kind: "commit",
        project: r.name,
        account: c.author,
        avatar: c.avatar,
        title: c.title,
        url: c.url,
        meta: c.sha,
        ai: c.ai,
        change: c.change,
        at: Date.parse(c.at),
      });
    }
    for (const p of r.pushes) {
      out.push({
        kind: "push",
        project: r.name,
        account: p.by,
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
        account: pr.by,
        avatar: "",
        title: `#${pr.number} ${pr.title}`,
        url: pr.url,
        meta: pr.state === "merged" ? `merged${pr.mergedBy ? ` by ${pr.mergedBy}` : ""}` : pr.state,
        at: Date.parse(pr.at),
      });
    }
  }
  for (const dep of data?.deploys ?? []) {
    if (dep.error) continue;
    out.push({
      kind: "deploy",
      project: dep.project,
      account: dep.by,
      avatar: "",
      title: dep.commit ? `deployed ${dep.commit} ${dep.message}` : `deployed (${dep.via})`,
      url: dep.url,
      meta: dep.target,
      state: dep.state,
      at: Date.parse(dep.at),
    });
  }
  for (const a of actions) {
    void loadProfile(a.uid);
    if (a.target && /^member\.|^message\./.test(a.action)) a.target.split(",").forEach((u) => void loadProfile(u));
    if (a.serverId) void loadServerName(a.serverId);
    out.push({
      kind: "action",
      project: "Darkwood Node app",
      account: a.uid,
      avatar: "",
      title: (ACTION_TEXT[a.action] ?? ((e: AuditEntry) => `${e.action} ${e.target ?? ""}`))(a),
      url: "",
      meta: a.serverId && serverNames.get(a.serverId) ? `in ${serverNames.get(a.serverId)}` : "",
      at: a.at,
    });
  }
  return out.filter((e) => !Number.isNaN(e.at)).sort((a, b) => b.at - a.at);
}

// ---- drawing -------------------------------------------------------------------
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
function button(label: string, pressed: boolean, onClick: () => void) {
  const b = el("button", "", label);
  b.type = "button";
  b.setAttribute("aria-pressed", String(pressed));
  b.addEventListener("click", onClick);
  return b;
}
function face(src: string) {
  const img = el("img");
  img.alt = "";
  if (src) img.src = src;
  img.onerror = () => (img.style.visibility = "hidden");
  return img;
}
function ago(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" }) + " " + new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function render() {
  if (!data) return;
  const all = events();
  const projects = ["all", ...data.repos.map((r) => r.name)];
  $("projects").replaceChildren(
    ...projects.map((p) => button(p === "all" ? "All projects" : p, project === p, () => { project = p; shown = PAGE; render(); })),
  );
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
  const inProject = (e: Event) => project === "all" || e.project === project;

  // who did what, last 30 days: one card per person (or unknown account)
  const since = Date.now() - 30 * 86400_000;
  type Tally = { photo: string; counts: Record<Kind, number>; ai: Map<string, number>; areas: Map<string, number>; added: number; removed: number; last: number };
  const tally = new Map<string, Tally>();
  for (const e of all.filter((x) => x.at >= since && inProject(x))) {
    const who = whoOf(e);
    const t = tally.get(who) ?? { photo: "", counts: { commit: 0, push: 0, deploy: 0, pr: 0, action: 0 }, ai: new Map(), areas: new Map(), added: 0, removed: 0, last: 0 };
    t.counts[e.kind]++;
    t.photo ||= photoOf(e);
    t.last = Math.max(t.last, e.at);
    if (e.ai) t.ai.set(e.ai, (t.ai.get(e.ai) ?? 0) + 1);
    if (e.change) {
      t.added += e.change.added;
      t.removed += e.change.removed;
      for (const a of e.change.areas) t.areas.set(a, (t.areas.get(a) ?? 0) + 1);
    }
    tally.set(who, t);
  }
  $("people").replaceChildren(
    ...[...tally.entries()]
      .sort((a, b) => b[1].last - a[1].last)
      .map(([who, t]) => {
        const card = el("div", "person");
        const text = el("div");
        text.append(el("b", "", who));
        const c = t.counts;
        text.append(el("small", "", [`${c.commit} commits`, `${c.push} pushes`, `${c.deploy} deploys`, c.pr ? `${c.pr} PRs` : "", c.action ? `${c.action} actions` : ""].filter(Boolean).join(" · ")));
        if (t.ai.size) {
          const ai = el("div", "chips");
          for (const [name, n] of [...t.ai.entries()].sort((a, b) => b[1] - a[1])) ai.append(el("span", `ai ai-${name.replace(/\s/g, "")}`, `${name} ${n}`));
          text.append(ai);
        }
        if (t.areas.size) {
          const top = [...t.areas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([a]) => a).join(", ");
          text.append(el("small", "areas", `worked on ${top}${t.added || t.removed ? ` · +${t.added} −${t.removed}` : ""}`));
        }
        text.append(el("small", "", `last ${ago(t.last)}`));
        card.append(face(t.photo), text);
        return card;
      }),
  );
  if (!tally.size) $("people").textContent = "Nobody did anything here in the last 30 days.";

  // the timeline
  const picked = all.filter((e) => inProject(e) && kinds.has(e.kind));
  $("feed").replaceChildren(
    ...picked.slice(0, shown).map((e) => {
      const row = el("div", "ev");
      const what = el("div", "what");
      const line1 = el("div", "line1");
      line1.append(el("span", `tag ${e.kind}`, e.kind === "pr" ? "PR" : e.kind));
      const who = whoOf(e);
      line1.append(el("b", "", who));
      if (e.ai) line1.append(el("span", `ai ai-${e.ai.replace(/\s/g, "")}`, e.ai));
      line1.append(el("span", "proj", e.project));
      if (e.state) line1.append(el("span", `state ${e.state}`, e.state.toLowerCase()));
      const title = el(e.url ? "a" : "span", "title", e.title);
      if (title instanceof HTMLAnchorElement) {
        title.href = e.url;
        title.target = "_blank";
        title.rel = "noopener";
      }
      const metaParts = [e.meta];
      // the account behind a named person, so it stays clear which one it was
      if (e.kind !== "action" && who !== e.account) metaParts.push(e.account);
      if (e.change) metaParts.push(`${e.change.areas.join(", ")} · ${e.change.files} file${e.change.files === 1 ? "" : "s"} · +${e.change.added} −${e.change.removed}`);
      what.append(line1, title, el("span", "meta", metaParts.filter(Boolean).join(" · ")));
      const time = el("time", "", ago(e.at));
      time.title = new Date(e.at).toLocaleString();
      row.append(face(photoOf(e)), what, time);
      return row;
    }),
  );
  if (!picked.length) $("feed").textContent = "Nothing here yet.";
  const more = $("more") as HTMLButtonElement;
  more.hidden = picked.length <= shown;
  more.onclick = () => { shown += PAGE; render(); };

  const errors = data.repos.filter((r) => r.error).map((r) => `${r.name}: ${r.error}`);
  if (actionsError) errors.push(`Darkwood actions: ${actionsError}`);
  $("updated").textContent = `updated ${ago(Date.parse(data.at))}${errors.length ? ` · ${errors.join("; ")}` : ""}`;
}

// ---- the people editor (owner and admins) ------------------------------------------
const splitList = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
function renderEditor() {
  const box = $("editor");
  const rows = people.length
    ? people
    : // a start, from the accounts seen so far: the owner's GitHub and Vercel go together
      [{ id: "", name: "Kaalob", uid: auth.currentUser?.uid ?? "", github: ["devarim28supply-afk"], vercel: ["devarim28supply-9180"] },
       { id: "", name: "Tyler", uid: "", github: ["RiMyShrimp"], vercel: [] }];
  const list = el("div", "people-edit");
  const draw = (p: Person) => {
    const row = el("div", "pe-row");
    const name = el("input");
    name.placeholder = "Name";
    name.value = p.name;
    const gh = el("input");
    gh.placeholder = "GitHub accounts (comma)";
    gh.value = p.github.join(", ");
    const vc = el("input");
    vc.placeholder = "Vercel accounts (comma)";
    vc.value = p.vercel.join(", ");
    const uid = el("input");
    uid.placeholder = "Darkwood account id (optional, for their photo)";
    uid.value = p.uid;
    const del = button("Remove", false, async () => {
      if (p.id) await deleteDoc(doc(db, "activity_people", p.id)).catch((err) => alertBox(err));
      row.remove();
    });
    const save = button("Save", false, async () => {
      const id = p.id || name.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || `p${Date.now()}`;
      try {
        await setDoc(doc(db, "activity_people", id), {
          name: name.value.trim() || "Someone",
          uid: uid.value.trim(),
          github: splitList(gh.value),
          vercel: splitList(vc.value),
        });
        p.id = id;
        save.textContent = "Saved";
        setTimeout(() => (save.textContent = "Save"), 1500);
      } catch (err) {
        alertBox(err);
      }
    });
    row.append(name, gh, vc, uid, save, del);
    list.append(row);
  };
  rows.forEach(draw);
  const add = button("+ Person", false, () => draw({ id: "", name: "", uid: "", github: [], vercel: [] }));
  const hint = el("p", "hint", "Each person's GitHub and Vercel accounts count as them. Only the owner and admins can save. Your own Darkwood account id: " + (auth.currentUser?.uid ?? ""));
  box.replaceChildren(hint, list, add);
}
function alertBox(err: unknown) {
  $("editor-msg").textContent = `Could not save: ${err instanceof Error ? err.message : String(err)} (owner and admins only; the database rule may not be published yet)`;
}

// ---- the Commit & Deploy Lane (COMMIT-DEPLOY-LANE.md), live every 15 s ----------------
type LaneTurn = { who: string; agent: string; what: string; since: string; url: string };
type Lane = {
  url: string;
  holder?: LaneTurn | null;
  queue?: LaneTurn[];
  lastRelease?: { who: string; agent: string; note: string; at: string } | null;
  urgent?: { who: string; at: string } | null;
  error?: string;
};
let lane: Lane | null = null;
const LANE_MS = 15_000;
/** A GitHub account as its person: "Tyler (Codex)". */
function laneName(login: string, agent: string) {
  const person = personOf("commit", login);
  return `${person?.name ?? login}${agent ? ` (${agent})` : ""}`;
}
function since(iso: string) {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
}
function renderLane() {
  const box = $("lane");
  if (!lane) return;
  box.hidden = false;
  const held = Boolean(lane.holder);
  box.className = `lane ${held ? "held" : "clear"}`;
  const top = el("div", "lane-top");
  top.append(el("span", "lane-dot"), el("span", "lane-title", lane.error ? "Commit & Deploy Lane" : held ? "Lane held" : "Lane clear: main is free"));
  const link = el("a", "", "lane issue ↗");
  link.href = lane.url;
  link.target = "_blank";
  link.rel = "noopener";
  top.append(link);
  const parts: HTMLElement[] = [top];
  if (lane.error) parts.push(el("p", "", lane.error));
  if (lane.holder) {
    const p = el("p");
    p.append(
      el("b", "", laneName(lane.holder.who, lane.holder.agent)),
      ` holds it, for ${since(lane.holder.since)}${lane.holder.what ? `: ${lane.holder.what}` : ""}. Nobody else pushes to main.`,
    );
    parts.push(p);
  } else if (lane.lastRelease) {
    const r = lane.lastRelease;
    parts.push(el("p", "", `Last released by ${laneName(r.who, r.agent)} ${ago(Date.parse(r.at))}${r.note ? `: ${r.note}` : ""}`));
  }
  if (lane.urgent) parts.push(el("p", "urgent", `${laneName(lane.urgent.who, "")} asked for the lane urgently, ${ago(Date.parse(lane.urgent.at))}.`));
  if (lane.queue?.length) {
    parts.push(el("p", "", held ? "Waiting for their turn:" : "Waiting (the first goes next):"));
    const ol = el("ol");
    for (const q of lane.queue) ol.append(el("li", "", `${laneName(q.who, q.agent)}, waiting ${since(q.since)}${q.what ? `: ${q.what}` : ""}`));
    parts.push(ol);
  } else if (!lane.error) parts.push(el("p", "", "Nobody waiting."));
  box.replaceChildren(...parts);
}
async function loadLane() {
  const user = auth.currentUser;
  if (!user) return;
  try {
    const res = await fetch("/api/activity?lane", { headers: { Authorization: `Bearer ${await user.getIdToken()}` } });
    if (!res.ok) return;
    lane = (await res.json()) as Lane;
    renderLane();
  } catch {
    /* next try in 15 s */
  }
}

// ---- loading ---------------------------------------------------------------------
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

// inside Darkwood Node's Activity window: no way back needed, it has its own close button
if (new URLSearchParams(location.search).has("embed")) document.body.classList.add("embedded");

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
  void loadLane();
  window.setInterval(() => void loadLane(), LANE_MS);
  // keep "x min ago" fresh between loads
  window.setInterval(() => {
    render();
    renderLane();
  }, 30_000);
  // the action log and the people list update live
  watchAudit(
    (list) => {
      actions = list;
      actionsError = "";
      render();
    },
    () => {
      actionsError = "the action log rule is not published yet";
      render();
    },
  );
  onSnapshot(
    collection(db, "activity_people"),
    (snap) => {
      people = snap.docs.map((d) => {
        const x = d.data();
        return { id: d.id, name: String(x.name ?? ""), uid: String(x.uid ?? ""), github: x.github ?? [], vercel: x.vercel ?? [] };
      });
      people.forEach((p) => void loadProfile(p.uid));
      render();
    },
    () => {},
  );
  $("edit-people").addEventListener("click", () => {
    const box = $("editor-wrap");
    box.hidden = !box.hidden;
    if (!box.hidden) renderEditor();
  });
});
