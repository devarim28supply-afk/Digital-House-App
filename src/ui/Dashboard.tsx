import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import { ACTION_LABEL, type AuditEntry, audit, watchAudit } from "../data/audit";
import { availabilityStatus } from "../data/status";
import { watchAllFeedback } from "../data/feedback";
import { type Profile, type Server, ONLINE_WINDOW_MS, displayName, watchAllServers, watchPresence } from "../data/store";
import { Inbox } from "./Feedback";
import { access, auth } from "../firebase";
import { OversightBody } from "./Oversight";
import { faceStyle, faceText } from "./Shell";
import "./dashboard.css";

/*
 * Dashboard: staff's one place for all of it — join requests, every member's
 * standing (approve, deny, suspend, ban, restore), who is online and where,
 * every server's size, looking into any server (Oversight), answering
 * feedback (Inbox), who committed/pushed/deployed what (Activity), and the
 * live audit trail. Calls the same access.admin methods the bunker's own
 * admin panel uses (members/{uid}.status and .roles — M2A-Access-Control's
 * rules let staff write them). Nothing here is new data: it is Roles'
 * members list, Oversight's server list, Feedback's inbox, Activity's feed,
 * presence, and the audit log, brought together in one place and kept live.
 */

type Role = "staff" | "admin" | "develop";
type Status = "pending" | "approved" | "denied" | "suspended" | "banned";
type MemberRow = {
  uid: string;
  name?: string;
  username?: string;
  email?: string;
  status?: string;
  roles?: Partial<Record<Role, boolean>>;
};

export type Tab = "overview" | "members" | "online" | "servers" | "oversight" | "feedback" | "activity" | "audit";
type Confirm = { row: MemberRow; status: Status; label: string };

const NAV: { id: Tab; label: string; glyph: string; hint: string }[] = [
  { id: "overview", label: "Overview", glyph: "◈", hint: "How things stand right now" },
  { id: "members", label: "Members", glyph: "◉", hint: "Approve, deny, suspend, ban" },
  { id: "online", label: "Online", glyph: "●", hint: "Who's here and where" },
  { id: "servers", label: "Servers", glyph: "▦", hint: "Every server, DMs excluded" },
  { id: "oversight", label: "Oversight", glyph: "◎", hint: "Look into any server, read-only" },
  { id: "feedback", label: "Feedback", glyph: "✉", hint: "Everyone's bug reports and ideas" },
  { id: "activity", label: "Activity", glyph: "▤", hint: "Commits, pushes and deploys" },
  { id: "audit", label: "Audit log", glyph: "≡", hint: "Every staff action, logged" },
];

const ACTIVITY_SEEN_KEY = "dh_activity_seen";
const ACTIVITY_POLL_MS = 60_000;
function lastActivitySeen() {
  try {
    const v = Number(localStorage.getItem(ACTIVITY_SEEN_KEY));
    if (v) return v;
  } catch {
    /* private mode */
  }
  const now = Date.now();
  try {
    localStorage.setItem(ACTIVITY_SEEN_KEY, String(now));
  } catch {
    /* private mode */
  }
  return now;
}

export function DashboardDialog(props: { open: boolean; onClose: () => void; profiles: Map<string, Profile>; uid: string; name: string; username: string; initialTab?: Tab }) {
  return (
    <Show when={props.open}>
      <DashboardScreen onClose={props.onClose} profiles={props.profiles} uid={props.uid} name={props.name} username={props.username} initialTab={props.initialTab} />
    </Show>
  );
}

function DashboardScreen(props: { onClose: () => void; profiles: Map<string, Profile>; uid: string; name: string; username: string; initialTab?: Tab }) {
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <div class="dashboard-screen" role="dialog" aria-modal="true" aria-label="Dashboard">
      <header class="dashboard-screen-head">
        <h2>Dashboard</h2>
        <button class="icon-btn" type="button" aria-label="Close" onClick={props.onClose}>
          ✕
        </button>
      </header>
      <DashboardBody profiles={props.profiles} uid={props.uid} name={props.name} username={props.username} initialTab={props.initialTab} />
    </div>
  );
}

function DashboardBody(props: { profiles: Map<string, Profile>; uid: string; name: string; username: string; initialTab?: Tab }) {
  const [tab, setTab] = createSignal<Tab>(props.initialTab ?? "overview");
  const [members, setMembers] = createSignal<MemberRow[] | undefined>();
  const [membersError, setMembersError] = createSignal("");
  const [memberQuery, setMemberQuery] = createSignal("");
  const [busy, setBusy] = createSignal(new Set<string>());
  const [servers, setServers] = createSignal<Server[] | undefined>();
  const [serversError, setServersError] = createSignal("");
  const [presence, setPresence] = createSignal<Map<string, import("../data/store").Presence>>(new Map());
  const [entries, setEntries] = createSignal<AuditEntry[]>([]);
  const [auditQuery, setAuditQuery] = createSignal("");
  const [now, setNow] = createSignal(Date.now());
  const [workTimes, setWorkTimes] = createSignal<number[]>([]);
  const [activitySeen, setActivitySeen] = createSignal(lastActivitySeen());
  const [feedbackNew, setFeedbackNew] = createSignal(0);

  const nameOf = (uid: string, row?: MemberRow) =>
    displayName(props.profiles.get(uid) ?? (row ? { name: row.name ?? "", username: row.username ?? "" } : undefined), row?.name || row?.username || "Member");

  async function loadMembers() {
    try {
      setMembers((await access.admin.listMembers()) as MemberRow[]);
    } catch {
      setMembersError("Could not load the members.");
      setMembers([]);
    }
  }

  // Commits, pushes, deploys and pull requests, for the Activity tab's badge
  // (the same count ActivityPanel used to poll before Activity moved in here).
  async function pollWork() {
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) return;
      const res = await fetch("/api/activity", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const d = (await res.json()) as {
        repos: { commits: { at: string }[]; pushes: { at: string }[]; pulls: { at: string }[] }[];
        deploys: { at?: string }[];
      };
      setWorkTimes(
        [
          ...d.repos.flatMap((r) => [...r.commits, ...r.pushes, ...r.pulls].map((x) => Date.parse(x.at))),
          ...d.deploys.map((x) => Date.parse(x.at ?? "")),
        ].filter((t) => !Number.isNaN(t)),
      );
    } catch {
      /* try again next minute */
    }
  }

  onMount(() => {
    void loadMembers();
    const stopServers = watchAllServers(setServers, () => setServersError("Could not load the servers."));
    const stopPresence = watchPresence(setPresence);
    const stopAudit = watchAudit(setEntries);
    const stopFeedback = watchAllFeedback((list) => setFeedbackNew(list.filter((f) => f.status === "new").length), () => {});
    void pollWork();
    if (props.initialTab === "activity") markActivitySeen();
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    const workTick = window.setInterval(() => void pollWork(), ACTIVITY_POLL_MS);
    onCleanup(() => {
      stopServers();
      stopPresence();
      stopAudit();
      stopFeedback();
      window.clearInterval(tick);
      window.clearInterval(workTick);
    });
  });

  const activityUnseen = createMemo(
    () => [...workTimes(), ...entries().filter((e) => e.uid !== props.uid).map((e) => e.at)].filter((t) => t > activitySeen()).length,
  );
  function markActivitySeen() {
    const now = Date.now();
    setActivitySeen(now);
    try {
      localStorage.setItem(ACTIVITY_SEEN_KEY, String(now));
    } catch {
      /* private mode */
    }
  }
  function selectTab(id: Tab) {
    setTab(id);
    if (id === "activity") markActivitySeen();
  }

  const matches = (row: MemberRow, term: string) =>
    !term || `${nameOf(row.uid, row)} ${row.username ?? ""}`.toLowerCase().includes(term);

  const byStatus = (status: Status) => {
    const term = memberQuery().trim().toLowerCase();
    return (members() ?? []).filter((m) => m.status === status && matches(m, term));
  };
  const approved = createMemo(() => byStatus("approved"));
  const pending = createMemo(() => byStatus("pending"));
  const denied = createMemo(() => byStatus("denied"));
  const suspended = createMemo(() => byStatus("suspended"));
  const banned = createMemo(() => byStatus("banned"));
  const pendingTotal = createMemo(() => members()?.filter((m) => m.status === "pending").length ?? 0);

  const allApproved = createMemo(() => members()?.filter((m) => m.status === "approved") ?? []);
  const staffMembers = createMemo(() => allApproved().filter((m) => m.roles?.staff || m.roles?.develop));
  const admins = createMemo(() => allApproved().filter((m) => m.roles?.admin));
  const developers = createMemo(() => allApproved().filter((m) => m.roles?.develop));
  const suspendedTotal = createMemo(() => members()?.filter((m) => m.status === "suspended").length ?? 0);
  const bannedTotal = createMemo(() => members()?.filter((m) => m.status === "banned").length ?? 0);

  const isOnline = (uid: string) => {
    const p = presence().get(uid);
    if (!p) return false;
    return availabilityStatus(props.profiles.get(uid)?.availability) !== "invisible" && now() - p.lastSeen < ONLINE_WINDOW_MS;
  };
  const online = createMemo(() => allApproved().filter((m) => isOnline(m.uid)));

  const recent24h = createMemo(() => entries().filter((e) => now() - e.at < 24 * 60 * 60_000));
  const topActions = createMemo(() => {
    const counts = new Map<string, number>();
    for (const e of recent24h()) counts.set(e.action, (counts.get(e.action) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  });
  const maxTopCount = createMemo(() => Math.max(1, ...topActions().map((t) => t[1])));
  const recentFeed = createMemo(() => entries().slice(0, 6));

  const AUDIT_FOR: Record<Status, "member.approve" | "member.deny" | "member.suspend" | "member.ban" | "member.restore"> = {
    approved: "member.approve",
    denied: "member.deny",
    suspended: "member.suspend",
    banned: "member.ban",
    pending: "member.restore",
  };

  async function setStatus(row: MemberRow, status: Status) {
    if (busy().has(row.uid)) return;
    setBusy((prev) => new Set(prev).add(row.uid));
    try {
      if (status === "approved") await access.admin.approve(row.uid);
      else if (status === "denied") await access.admin.deny(row.uid);
      else if (status === "pending") await access.admin.reset(row.uid);
      else if (status === "suspended") await access.admin.suspend(row.uid);
      else await access.admin.ban(row.uid);
      setMembers((prev) => prev?.map((m) => (m.uid === row.uid ? { ...m, status } : m)));
      audit(AUDIT_FOR[status], { target: nameOf(row.uid, row) });
    } catch {
      setMembersError(`Could not change ${nameOf(row.uid, row)}. The database refused it.`);
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(row.uid);
        return next;
      });
    }
  }

  // Suspend and ban lock someone out of the whole app, not just a server —
  // ask first, the same as a strong role change in Roles.
  const [confirm, setConfirm] = createSignal<Confirm | undefined>();
  const ask = (row: MemberRow, status: Status, label: string) => setConfirm({ row, status, label });

  const filteredEntries = createMemo(() => {
    const term = auditQuery().trim().toLowerCase();
    const list = entries().slice(0, 300);
    if (!term) return list;
    return list.filter((e) => {
      const label = ACTION_LABEL[e.action as keyof typeof ACTION_LABEL] ?? e.action;
      return `${nameOf(e.uid)} ${label} ${e.target ?? ""} ${e.detail ?? ""}`.toLowerCase().includes(term);
    });
  });
  const auditDays = createMemo(() => {
    const groups: { day: string; items: AuditEntry[] }[] = [];
    for (const e of filteredEntries()) {
      const day = new Date(e.at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.items.push(e);
      else groups.push({ day, items: [e] });
    }
    return groups;
  });
  const actionAccent = (action: string) =>
    action.startsWith("member.") ? "accent-green" : action === "oversight.view" ? "accent-amber" : "accent-dim";

  return (
    <div class="dashboard">
      <nav class="dashboard-nav">
        <For each={NAV}>
          {(t) => (
            <button
              type="button"
              class="dashboard-nav-item"
              classList={{ active: tab() === t.id }}
              onClick={() => selectTab(t.id)}
              title={t.hint}
            >
              <span class="dashboard-nav-glyph" aria-hidden="true">
                {t.glyph}
              </span>
              <span class="dashboard-nav-text">
                <span class="dashboard-nav-label">{t.label}</span>
                <span class="dashboard-nav-hint">{t.hint}</span>
              </span>
              <Show when={t.id === "members" && pendingTotal() > 0}>
                <span class="dashboard-badge">{pendingTotal()}</span>
              </Show>
              <Show when={t.id === "online" && online().length > 0}>
                <span class="dashboard-badge soft">{online().length}</span>
              </Show>
              <Show when={t.id === "feedback" && feedbackNew() > 0}>
                <span class="dashboard-badge">{feedbackNew()}</span>
              </Show>
              <Show when={t.id === "activity" && activityUnseen() > 0}>
                <span class="dashboard-badge">{activityUnseen() > 99 ? "99+" : activityUnseen()}</span>
              </Show>
            </button>
          )}
        </For>
      </nav>

      <div class="dashboard-content">
        <Show when={tab() === "overview"}>
          <h1 class="dashboard-title">Overview</h1>
          <p class="modal-text">Darkwood Node, right now.</p>
          <div class="dashboard-stats">
            <StatTile label="Servers" value={servers()?.length ?? "…"} />
            <StatTile label="Approved members" value={allApproved().length || (members() ? 0 : "…")} />
            <StatTile label="Online now" value={online().length} accent="green" />
            <StatTile label="Pending" value={pendingTotal()} accent={pendingTotal() > 0 ? "amber" : undefined} />
            <StatTile label="Staff" value={staffMembers().length} />
            <StatTile label="Admins" value={admins().length} />
            <StatTile label="Developers" value={developers().length} />
            <StatTile label="Suspended" value={suspendedTotal()} accent={suspendedTotal() > 0 ? "amber" : undefined} />
            <StatTile label="Banned" value={bannedTotal()} accent={bannedTotal() > 0 ? "red" : undefined} />
          </div>

          <h3 class="dashboard-subhead">Busiest in the last 24 hours</h3>
          <Show when={topActions().length} fallback={<p class="modal-text">Nothing logged in the last day.</p>}>
            <div class="dashboard-bars">
              <For each={topActions()}>
                {([action, count]) => (
                  <div class="dashboard-bar-row">
                    <span class="dashboard-bar-label">{ACTION_LABEL[action as keyof typeof ACTION_LABEL] ?? action}</span>
                    <div class="dashboard-bar-track">
                      <div class="dashboard-bar-fill" style={{ width: `${(count / maxTopCount()) * 100}%` }} />
                    </div>
                    <span class="dashboard-bar-count">{count}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <div class="dashboard-subhead-row">
            <h3 class="dashboard-subhead">Recent activity</h3>
            <Show when={entries().length}>
              <button class="dashboard-link" type="button" onClick={() => setTab("audit")}>
                View the full log →
              </button>
            </Show>
          </div>
          <Show when={recentFeed().length} fallback={<p class="modal-text">Nothing logged yet.</p>}>
            <div class="dashboard-audit">
              <For each={recentFeed()}>
                {(e) => (
                  <div class={`dashboard-audit-row ${actionAccent(e.action)}`}>
                    <time>{new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
                    <span>
                      <b>{nameOf(e.uid)}</b> {ACTION_LABEL[e.action as keyof typeof ACTION_LABEL] ?? e.action}
                      <Show when={e.target}> — {e.target}</Show>
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>

        <Show when={tab() === "members"}>
          <h1 class="dashboard-title">Members</h1>
          <p class="modal-text">Everyone who has ever asked to join, and what you've decided.</p>
          <input
            class="roles-search"
            type="search"
            placeholder="Find a member"
            aria-label="Find a member"
            value={memberQuery()}
            onInput={(e) => setMemberQuery(e.currentTarget.value)}
          />
          <Show when={membersError()}>
            <p class="roles-error" role="alert">
              {membersError()}
            </p>
          </Show>
          <Show when={confirm()}>
            {(c) => (
              <div class="roles-confirm" role="alertdialog" aria-label={`Confirm ${c().label}`}>
                <p class="modal-text">
                  {c().label} {nameOf(c().row.uid, c().row)}? {c().status === "banned" && "This locks them out of the whole app."}
                  {c().status === "suspended" && "This locks them out of the whole app until restored."}
                </p>
                <div class="modal-actions">
                  <button
                    class="btn"
                    type="button"
                    onClick={() => {
                      const { row, status } = c();
                      setConfirm(undefined);
                      void setStatus(row, status);
                    }}
                  >
                    Yes
                  </button>
                  <button class="btn" type="button" onClick={() => setConfirm(undefined)}>
                    No
                  </button>
                </div>
              </div>
            )}
          </Show>
          <Show when={members()} fallback={<p class="modal-text">Loading…</p>}>
            <h3 class="dashboard-subhead">Waiting to join ({pending().length})</h3>
            <div class="people-list find-list dashboard-people">
              <For each={pending()} fallback={<p class="modal-text">Nobody is waiting.</p>}>
                {(row) => (
                  <div class="person">
                    <span class="avatar small" style={faceStyle(props.profiles.get(row.uid))}>
                      {faceText(props.profiles.get(row.uid), nameOf(row.uid, row))}
                    </span>
                    <span class="member-name">
                      {nameOf(row.uid, row)} <small>@{row.username || "member"}</small>
                    </span>
                    <button class="btn" type="button" disabled={busy().has(row.uid)} onClick={() => void setStatus(row, "approved")}>
                      Approve
                    </button>
                    <button class="btn" type="button" disabled={busy().has(row.uid)} onClick={() => void setStatus(row, "denied")}>
                      Deny
                    </button>
                  </div>
                )}
              </For>
            </div>

            <h3 class="dashboard-subhead">Approved ({approved().length})</h3>
            <div class="people-list find-list dashboard-people">
              <For each={approved()} fallback={<p class="modal-text">No approved members.</p>}>
                {(row) => (
                  <div class="person">
                    <span class="avatar small" style={faceStyle(props.profiles.get(row.uid))}>
                      {faceText(props.profiles.get(row.uid), nameOf(row.uid, row))}
                    </span>
                    <span class="member-name">
                      {nameOf(row.uid, row)} <small>@{row.username || "member"}</small>
                    </span>
                    <Show when={row.roles?.staff || row.roles?.develop}>
                      <span class="dashboard-pill staff">Staff</span>
                    </Show>
                    <Show when={row.roles?.admin}>
                      <span class="dashboard-pill">Admin</span>
                    </Show>
                    <button class="btn" type="button" disabled={busy().has(row.uid)} onClick={() => ask(row, "suspended", "Suspend")}>
                      Suspend
                    </button>
                    <button class="btn" type="button" disabled={busy().has(row.uid)} onClick={() => ask(row, "banned", "Ban")}>
                      Ban
                    </button>
                  </div>
                )}
              </For>
            </div>

            <Show when={suspended().length}>
              <details class="dashboard-group" open>
                <summary class="dashboard-subhead">Suspended ({suspended().length})</summary>
                <div class="people-list find-list dashboard-people">
                  <For each={suspended()}>
                    {(row) => (
                      <div class="person">
                        <span class="avatar small" style={faceStyle(props.profiles.get(row.uid))}>
                          {faceText(props.profiles.get(row.uid), nameOf(row.uid, row))}
                        </span>
                        <span class="member-name">
                          {nameOf(row.uid, row)} <small>@{row.username || "member"}</small>
                        </span>
                        <button class="btn" type="button" disabled={busy().has(row.uid)} onClick={() => void setStatus(row, "approved")}>
                          Restore
                        </button>
                        <button class="btn" type="button" disabled={busy().has(row.uid)} onClick={() => ask(row, "banned", "Ban")}>
                          Ban
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </details>
            </Show>

            <Show when={banned().length}>
              <details class="dashboard-group" open>
                <summary class="dashboard-subhead">Banned ({banned().length})</summary>
                <div class="people-list find-list dashboard-people">
                  <For each={banned()}>
                    {(row) => (
                      <div class="person">
                        <span class="avatar small" style={faceStyle(props.profiles.get(row.uid))}>
                          {faceText(props.profiles.get(row.uid), nameOf(row.uid, row))}
                        </span>
                        <span class="member-name">
                          {nameOf(row.uid, row)} <small>@{row.username || "member"}</small>
                        </span>
                        <button class="btn" type="button" disabled={busy().has(row.uid)} onClick={() => void setStatus(row, "pending")}>
                          Restore
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </details>
            </Show>

            <Show when={denied().length}>
              <details class="dashboard-group">
                <summary class="dashboard-subhead">Denied ({denied().length})</summary>
                <div class="people-list find-list dashboard-people">
                  <For each={denied()}>
                    {(row) => (
                      <div class="person">
                        <span class="avatar small" style={faceStyle(props.profiles.get(row.uid))}>
                          {faceText(props.profiles.get(row.uid), nameOf(row.uid, row))}
                        </span>
                        <span class="member-name">
                          {nameOf(row.uid, row)} <small>@{row.username || "member"}</small>
                        </span>
                        <button class="btn" type="button" disabled={busy().has(row.uid)} onClick={() => void setStatus(row, "pending")}>
                          Reopen
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </details>
            </Show>
          </Show>
        </Show>

        <Show when={tab() === "online"}>
          <h1 class="dashboard-title">Online</h1>
          <p class="modal-text">{online().length} online right now.</p>
          <div class="people-list find-list dashboard-people">
            <For each={online()} fallback={<p class="modal-text">Nobody is online.</p>}>
              {(row) => (
                <div class="person">
                  <span class="avatar small" style={faceStyle(props.profiles.get(row.uid))}>
                    {faceText(props.profiles.get(row.uid), nameOf(row.uid, row))}
                    <span class="dot" />
                  </span>
                  <span class="member-name">{nameOf(row.uid, row)}</span>
                  <span class="dashboard-where">{presence().get(row.uid)?.where || "—"}</span>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={tab() === "servers"}>
          <h1 class="dashboard-title">Servers</h1>
          <p class="modal-text">Every server except DMs, same as Oversight.</p>
          <Show when={serversError()}>
            <p class="roles-error" role="alert">
              {serversError()}
            </p>
          </Show>
          <div class="people-list find-list dashboard-people">
            <Show when={servers()} fallback={<p class="modal-text">Loading…</p>}>
              <For each={servers()} fallback={<p class="modal-text">No servers.</p>}>
                {(s) => (
                  <div class="person">
                    <span class="member-name">{s.name}</span>
                    <span class="dashboard-pill">{s.memberUids.length} member{s.memberUids.length === 1 ? "" : "s"}</span>
                    <span class="dashboard-pill" classList={{ staff: Boolean(s.open) }}>{s.open ? "Open" : "Invite only"}</span>
                    <span class="dashboard-where">owner: {nameOf(s.ownerUid)}</span>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Show>

        <Show when={tab() === "oversight"}>
          <h1 class="dashboard-title">Oversight</h1>
          <OversightBody profiles={props.profiles} />
        </Show>

        <Show when={tab() === "feedback"}>
          <h1 class="dashboard-title">Feedback</h1>
          <p class="modal-text">Everyone's bug reports and ideas. Reply and they see it in their own Feedback.</p>
          <Inbox by={props.username || props.name} />
        </Show>

        <Show when={tab() === "activity"}>
          <h1 class="dashboard-title">Activity</h1>
          <div class="dashboard-activity-head">
            <p class="modal-text">Who committed, pushed and deployed what.</p>
            <a class="dashboard-link" href={`${import.meta.env.BASE_URL}activity.html`} target="_blank" rel="noopener">
              Open in its own tab ↗
            </a>
          </div>
          <iframe class="dashboard-activity-frame" src={`${import.meta.env.BASE_URL}activity.html?embed`} title="Activity" />
        </Show>

        <Show when={tab() === "audit"}>
          <h1 class="dashboard-title">Audit log</h1>
          <p class="modal-text">Every staff action, permanently recorded.</p>
          <input
            class="roles-search"
            type="search"
            placeholder="Search the log"
            aria-label="Search the log"
            value={auditQuery()}
            onInput={(e) => setAuditQuery(e.currentTarget.value)}
          />
          <div class="dashboard-audit-days">
            <For each={auditDays()} fallback={<p class="modal-text">Nothing logged yet.</p>}>
              {(group) => (
                <div class="dashboard-audit-day">
                  <h4 class="dashboard-audit-date">{group.day}</h4>
                  <div class="dashboard-audit">
                    <For each={group.items}>
                      {(e) => (
                        <div class={`dashboard-audit-row ${actionAccent(e.action)}`}>
                          <time>{new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
                          <span>
                            <b>{nameOf(e.uid)}</b> {ACTION_LABEL[e.action as keyof typeof ACTION_LABEL] ?? e.action}
                            <Show when={e.target}> — {e.target}</Show>
                            <Show when={e.detail}> ({e.detail})</Show>
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}

function StatTile(props: { label: string; value: number | string; accent?: "green" | "amber" | "red" }) {
  return (
    <div class="dashboard-tile" classList={{ [`accent-${props.accent}`]: Boolean(props.accent) }}>
      <span class="dashboard-tile-value">{props.value}</span>
      <span class="dashboard-tile-label">{props.label}</span>
    </div>
  );
}
