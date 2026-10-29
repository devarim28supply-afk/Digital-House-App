import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import { ACTION_LABEL, type AuditEntry, audit, watchAudit } from "../data/audit";
import { availabilityStatus } from "../data/status";
import { watchAllFeedback } from "../data/feedback";
import { type StaffMessage, sendStaffMessage, watchStaffChat } from "../data/staffchat";
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

type LiveParticipant = {
  identity: string;
  name: string;
  joinedAt?: string;
  connectionQuality: "POOR" | "GOOD" | "EXCELLENT" | "UNKNOWN";
  audioMuted: boolean;
  videoMuted: boolean;
};
type LiveRoom = {
  name: string;
  serverId: string;
  channelId: string;
  is3dRoom: boolean;
  numParticipants: number;
  creationTime?: string;
  participants: LiveParticipant[];
};

type UploadsSummary = {
  totalCount: number;
  totalBytes: number;
  capped: boolean;
  byCategory: { category: string; count: number; bytes: number }[];
  recent: { pathname: string; url: string; size: number; uploadedAt: string; category: string }[];
};

export type Page = "insights" | "tools";
export type Section = "overview" | "members" | "staff" | "chat" | "online" | "servers" | "storage" | "feedback" | "audit";
type Confirm = { row: MemberRow; status: Status; label: string };

const SECTIONS: { id: Section; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "members", label: "Members" },
  { id: "staff", label: "Staff" },
  { id: "chat", label: "Staff Chat" },
  { id: "online", label: "Online" },
  { id: "servers", label: "Servers" },
  { id: "storage", label: "Storage" },
  { id: "feedback", label: "Feedback" },
  { id: "audit", label: "Audit log" },
];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

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

export function DashboardDialog(props: {
  open: boolean;
  onClose: () => void;
  profiles: Map<string, Profile>;
  uid: string;
  name: string;
  username: string;
  owner: boolean;
  onMessage: (uid: string) => void;
  initialPage?: Page;
  focusSection?: Section;
}) {
  return (
    <Show when={props.open}>
      <DashboardScreen
        onClose={props.onClose}
        profiles={props.profiles}
        uid={props.uid}
        name={props.name}
        username={props.username}
        owner={props.owner}
        onMessage={props.onMessage}
        initialPage={props.initialPage}
        focusSection={props.focusSection}
      />
    </Show>
  );
}

function DashboardScreen(props: {
  onClose: () => void;
  profiles: Map<string, Profile>;
  uid: string;
  name: string;
  username: string;
  owner: boolean;
  onMessage: (uid: string) => void;
  initialPage?: Page;
  focusSection?: Section;
}) {
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
      <DashboardBody
        profiles={props.profiles}
        uid={props.uid}
        name={props.name}
        username={props.username}
        owner={props.owner}
        onMessage={props.onMessage}
        initialPage={props.initialPage}
        focusSection={props.focusSection}
      />
    </div>
  );
}

function DashboardBody(props: {
  profiles: Map<string, Profile>;
  uid: string;
  name: string;
  username: string;
  owner: boolean;
  onMessage: (uid: string) => void;
  initialPage?: Page;
  focusSection?: Section;
}) {
  const [page, setPage] = createSignal<Page>(props.initialPage ?? "insights");
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
  const [chatMessages, setChatMessages] = createSignal<StaffMessage[]>([]);
  const [chatDraft, setChatDraft] = createSignal("");
  const [chatSending, setChatSending] = createSignal(false);
  const [chatError, setChatError] = createSignal("");
  let chatBottom: HTMLDivElement | undefined;
  const [liveRooms, setLiveRooms] = createSignal<LiveRoom[] | undefined>();
  const [roomsError, setRoomsError] = createSignal("");
  const [roomBusy, setRoomBusy] = createSignal(new Set<string>());
  const [uploads, setUploads] = createSignal<UploadsSummary | undefined>();
  const [uploadsError, setUploadsError] = createSignal("");
  const [uploadsLoading, setUploadsLoading] = createSignal(false);

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

  async function pollRooms() {
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) return;
      const res = await fetch("/api/dh-rooms", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
      if (!res.ok) return setRoomsError("Could not load live calls.");
      const d = (await res.json()) as { rooms?: LiveRoom[] };
      setRoomsError("");
      setLiveRooms(d.rooms ?? []);
    } catch {
      setRoomsError("Could not reach the call server.");
    }
  }

  async function endCall(room: string) {
    if (roomBusy().has(room)) return;
    setRoomBusy((prev) => new Set(prev).add(room));
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) return;
      const res = await fetch("/api/dh-rooms", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "end", room }),
      });
      if (res.ok) {
        setLiveRooms((prev) => prev?.filter((r) => r.name !== room));
        audit("call.remove", { target: room, detail: "ended the whole call" });
      } else {
        setRoomsError("Could not end that call.");
      }
    } catch {
      setRoomsError("Could not reach the call server.");
    } finally {
      setRoomBusy((prev) => {
        const next = new Set(prev);
        next.delete(room);
        return next;
      });
    }
  }

  async function loadUploads() {
    setUploadsLoading(true);
    setUploadsError("");
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) return;
      const res = await fetch("/api/dh-uploads", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return setUploadsError("Could not load uploads.");
      setUploads((await res.json()) as UploadsSummary);
    } catch {
      setUploadsError("Could not reach storage.");
    } finally {
      setUploadsLoading(false);
    }
  }

  onMount(() => {
    void loadMembers();
    void loadUploads();
    const stopServers = watchAllServers(setServers, () => setServersError("Could not load the servers."));
    const stopPresence = watchPresence(setPresence);
    const stopAudit = watchAudit(setEntries);
    const stopFeedback = watchAllFeedback((list) => setFeedbackNew(list.filter((f) => f.status === "new").length), () => {});
    const stopChat = watchStaffChat(
      (list) => {
        setChatMessages(list);
        queueMicrotask(() => chatBottom?.scrollIntoView({ block: "end" }));
      },
      () => setChatError("Could not load Staff Chat."),
    );
    void pollWork();
    void pollRooms();
    const roomsTick = window.setInterval(() => void pollRooms(), 15_000);
    if (props.initialPage === "tools") markActivitySeen();
    if (props.focusSection) {
      const id = `dashboard-section-${props.focusSection}`;
      window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    }
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    const workTick = window.setInterval(() => void pollWork(), ACTIVITY_POLL_MS);
    onCleanup(() => {
      stopServers();
      stopPresence();
      stopAudit();
      stopFeedback();
      stopChat();
      window.clearInterval(tick);
      window.clearInterval(workTick);
      window.clearInterval(roomsTick);
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
  function selectPage(id: Page) {
    setPage(id);
    if (id === "tools") markActivitySeen();
  }
  const jump = (id: Section) =>
    document.getElementById(`dashboard-section-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  const matches = (row: MemberRow, term: string) =>
    !term || `${nameOf(row.uid, row)} ${row.username ?? ""}`.toLowerCase().includes(term);

  const isStaffRow = (m: MemberRow) => Boolean(m.roles?.staff || m.roles?.develop);

  const byStatus = (status: Status) => {
    const term = memberQuery().trim().toLowerCase();
    return (members() ?? []).filter((m) => m.status === status && matches(m, term));
  };
  // Staff get their own list (below), not mixed into the regular member list.
  const approved = createMemo(() => byStatus("approved").filter((m) => !isStaffRow(m)));
  const staffList = createMemo(() => byStatus("approved").filter(isStaffRow));
  const pending = createMemo(() => byStatus("pending"));
  const denied = createMemo(() => byStatus("denied"));
  const suspended = createMemo(() => byStatus("suspended"));
  const banned = createMemo(() => byStatus("banned"));
  const pendingTotal = createMemo(() => members()?.filter((m) => m.status === "pending").length ?? 0);

  const allApproved = createMemo(() => members()?.filter((m) => m.status === "approved") ?? []);
  const staffMembers = createMemo(() => allApproved().filter(isStaffRow));
  const admins = createMemo(() => allApproved().filter((m) => m.roles?.admin));
  const developers = createMemo(() => allApproved().filter((m) => m.roles?.develop));
  const suspendedTotal = createMemo(() => members()?.filter((m) => m.status === "suspended").length ?? 0);
  const bannedTotal = createMemo(() => members()?.filter((m) => m.status === "banned").length ?? 0);

  // Already-loaded data (props.profiles), no new reads: how many approved
  // members have set up a picture or customized how they look.
  const profileStats = createMemo(() => {
    const list = allApproved();
    let photo = 0;
    let customized = 0;
    for (const m of list) {
      const p = props.profiles.get(m.uid);
      if (p?.photo) photo++;
      if (p?.customization || p?.banner || p?.background) customized++;
    }
    return { total: list.length, photo, customized };
  });

  const isOnline = (uid: string) => {
    const p = presence().get(uid);
    if (!p) return false;
    return availabilityStatus(props.profiles.get(uid)?.availability) !== "invisible" && now() - p.lastSeen < ONLINE_WINDOW_MS;
  };
  const online = createMemo(() => allApproved().filter((m) => isOnline(m.uid)));

  // A logging bug could spam identical entries before it was fixed (or a
  // legitimate action can just repeat) - collapse a run of them into one row
  // with a count instead of showing each one, rather than ever deleting
  // audit history.
  const collapsedEntries = createMemo(() => {
    const out: (AuditEntry & { count: number })[] = [];
    for (const e of entries()) {
      const last = out[out.length - 1];
      if (last && last.uid === e.uid && last.action === e.action && (last.target ?? "") === (e.target ?? "") && (last.detail ?? "") === (e.detail ?? "")) {
        last.count++;
      } else {
        out.push({ ...e, count: 1 });
      }
    }
    return out;
  });
  // "Busiest in the last 24 hours" counts collapsed entries too, so a run of
  // duplicates from a logging bug (or any repeat) tallies as the one row it
  // shows, not once per raw document.
  const recent24h = createMemo(() => collapsedEntries().filter((e) => now() - e.at < 24 * 60 * 60_000));
  const topActions = createMemo(() => {
    const counts = new Map<string, number>();
    for (const e of recent24h()) counts.set(e.action, (counts.get(e.action) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  });
  const maxTopCount = createMemo(() => Math.max(1, ...topActions().map((t) => t[1])));
  // Which servers show up most in the (already fully loaded) audit log -
  // not raw message counts, which would mean reading message content across
  // servers staff hasn't actually opened, outside the Oversight flow.
  const busiestServers = createMemo(() => {
    const counts = new Map<string, number>();
    for (const e of recent24h()) if (e.serverId) counts.set(e.serverId, (counts.get(e.serverId) ?? 0) + 1);
    return [...counts.entries()]
      .map(([sid, count]) => [servers()?.find((s) => s.id === sid)?.name ?? sid, count] as [string, number])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
  });
  const maxBusiestServer = createMemo(() => Math.max(1, ...busiestServers().map((t) => t[1])));
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

  async function sendChat(e: Event) {
    e.preventDefault();
    const text = chatDraft().trim();
    if (!text || chatSending()) return;
    setChatSending(true);
    setChatError("");
    try {
      await sendStaffMessage(props.uid, text);
      setChatDraft("");
    } catch {
      setChatError("Could not send. Try again.");
    } finally {
      setChatSending(false);
    }
  }

  const filteredEntries = createMemo(() => {
    const term = auditQuery().trim().toLowerCase();
    const list = collapsedEntries().slice(0, 300);
    if (!term) return list;
    return list.filter((e) => {
      const label = ACTION_LABEL[e.action as keyof typeof ACTION_LABEL] ?? e.action;
      return `${nameOf(e.uid)} ${label} ${e.target ?? ""} ${e.detail ?? ""}`.toLowerCase().includes(term);
    });
  });
  const auditDays = createMemo(() => {
    const groups: { day: string; items: (AuditEntry & { count: number })[] }[] = [];
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
      <div class="dashboard-toolbar">
        <div class="dashboard-pages" role="tablist">
          <button type="button" class="dashboard-page-btn" classList={{ active: page() === "insights" }} onClick={() => selectPage("insights")}>
            Insights
          </button>
          <button type="button" class="dashboard-page-btn" classList={{ active: page() === "tools" }} onClick={() => selectPage("tools")}>
            Tools
            <Show when={activityUnseen() > 0}>
              <span class="dashboard-badge">{activityUnseen() > 99 ? "99+" : activityUnseen()}</span>
            </Show>
          </button>
        </div>
        <Show when={page() === "insights"}>
          <div class="dashboard-jumps">
            <For each={SECTIONS}>
              {(s) => (
                <button type="button" class="dashboard-jump" onClick={() => jump(s.id)}>
                  {s.label}
                  <Show when={s.id === "members" && pendingTotal() > 0}> ({pendingTotal()})</Show>
                  <Show when={s.id === "online" && online().length > 0}> ({online().length})</Show>
                  <Show when={s.id === "feedback" && feedbackNew() > 0}> ({feedbackNew()})</Show>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="dashboard-content">
        <Show when={page() === "insights"}>
        <div class="dashboard-grid">
          <section id="dashboard-section-overview" class="dashboard-section">
            <h1 class="dashboard-title">Overview</h1>
            <p class="modal-text">Darkwood Node, right now.</p>
            <div class="dashboard-overview-row">
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

              <div class="dashboard-overview-bars">
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

                <h3 class="dashboard-subhead">Busiest servers in the last 24 hours</h3>
                <Show when={busiestServers().length} fallback={<p class="modal-text">Nothing logged in the last day.</p>}>
                  <div class="dashboard-bars">
                    <For each={busiestServers()}>
                      {([name, count]) => (
                        <div class="dashboard-bar-row">
                          <span class="dashboard-bar-label">{name}</span>
                          <div class="dashboard-bar-track">
                            <div class="dashboard-bar-fill" style={{ width: `${(count / maxBusiestServer()) * 100}%` }} />
                          </div>
                          <span class="dashboard-bar-count">{count}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </div>
          </section>

          <div class="dashboard-masonry">
          <section id="dashboard-section-members" class="dashboard-section">
            <h2 class="dashboard-title">Members</h2>
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
                      <Show when={row.roles?.admin}>
                        <span class="dashboard-pill">Admin</span>
                      </Show>
                      <Show when={props.owner}>
                        <button class="btn" type="button" disabled={busy().has(row.uid)} onClick={() => ask(row, "suspended", "Suspend")}>
                          Suspend
                        </button>
                        <button class="btn" type="button" disabled={busy().has(row.uid)} onClick={() => ask(row, "banned", "Ban")}>
                          Ban
                        </button>
                      </Show>
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
                          <Show when={props.owner}>
                            <button class="btn" type="button" disabled={busy().has(row.uid)} onClick={() => void setStatus(row, "approved")}>
                              Restore
                            </button>
                            <button class="btn" type="button" disabled={busy().has(row.uid)} onClick={() => ask(row, "banned", "Ban")}>
                              Ban
                            </button>
                          </Show>
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
                          <Show when={props.owner}>
                            <button class="btn" type="button" disabled={busy().has(row.uid)} onClick={() => void setStatus(row, "pending")}>
                              Restore
                            </button>
                          </Show>
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
          </section>

          <section id="dashboard-section-staff" class="dashboard-section">
            <h2 class="dashboard-title">Staff</h2>
            <p class="modal-text">Reaches every server. A Developer counts as staff too.</p>
            <div class="people-list find-list dashboard-people">
              <For each={staffList()} fallback={<p class="modal-text">No staff yet.</p>}>
                {(row) => (
                  <div class="person">
                    <span class="avatar small" style={faceStyle(props.profiles.get(row.uid))}>
                      {faceText(props.profiles.get(row.uid), nameOf(row.uid, row))}
                    </span>
                    <span class="member-name">
                      {nameOf(row.uid, row)} <small>@{row.username || "member"}</small>
                    </span>
                    <span class="dashboard-pill staff">Staff</span>
                    <Show when={row.roles?.admin}>
                      <span class="dashboard-pill">Admin</span>
                    </Show>
                    <Show when={row.uid !== props.uid}>
                      <button class="btn" type="button" onClick={() => props.onMessage(row.uid)}>
                        Message
                      </button>
                    </Show>
                    <Show when={props.owner}>
                      <button class="btn" type="button" disabled={busy().has(row.uid)} onClick={() => ask(row, "suspended", "Suspend")}>
                        Suspend
                      </button>
                      <button class="btn" type="button" disabled={busy().has(row.uid)} onClick={() => ask(row, "banned", "Ban")}>
                        Ban
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </section>

          <section id="dashboard-section-chat" class="dashboard-section">
            <h2 class="dashboard-title">Staff Chat</h2>
            <p class="modal-text">A place for staff to talk, not visible to anyone else.</p>
            <Show when={chatError()}>
              <p class="roles-error" role="alert">
                {chatError()}
              </p>
            </Show>
            <div class="dashboard-chat-log">
              <For each={chatMessages()} fallback={<p class="modal-text">Nobody has said anything yet.</p>}>
                {(m) => (
                  <div class="dashboard-chat-row">
                    <span class="avatar small" style={faceStyle(props.profiles.get(m.uid))}>
                      {faceText(props.profiles.get(m.uid), nameOf(m.uid))}
                    </span>
                    <div class="dashboard-chat-body">
                      <span class="dashboard-chat-head">
                        <b>{nameOf(m.uid)}</b>
                        <time>{new Date(m.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
                      </span>
                      <span class="dashboard-chat-text">{m.text}</span>
                    </div>
                  </div>
                )}
              </For>
              <div ref={chatBottom} />
            </div>
            <form class="dashboard-chat-form" onSubmit={sendChat}>
              <input
                type="text"
                placeholder="Message staff"
                aria-label="Message staff"
                value={chatDraft()}
                maxLength={2000}
                disabled={chatSending()}
                onInput={(e) => setChatDraft(e.currentTarget.value)}
              />
              <button class="btn" type="submit" disabled={chatSending() || !chatDraft().trim()}>
                Send
              </button>
            </form>
          </section>

          <section id="dashboard-section-online" class="dashboard-section">
            <h2 class="dashboard-title">Online</h2>
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
          </section>

          <section id="dashboard-section-servers" class="dashboard-section">
            <h2 class="dashboard-title">Servers</h2>
            <p class="modal-text">Every server except DMs, same as Oversight on the Tools page.</p>
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
          </section>

          <section id="dashboard-section-storage" class="dashboard-section">
            <h2 class="dashboard-title">Storage</h2>
            <p class="modal-text">Firebase profiles and Vercel Blob uploads.</p>

            <h3 class="dashboard-subhead">Profile completeness</h3>
            <div class="dashboard-stats">
              <StatTile label="Have a picture" value={`${profileStats().photo}/${profileStats().total}`} />
              <StatTile label="Customized their look" value={`${profileStats().customized}/${profileStats().total}`} />
            </div>

            <div class="dashboard-subhead-row">
              <h3 class="dashboard-subhead">Uploads</h3>
              <button class="dashboard-link" type="button" disabled={uploadsLoading()} onClick={() => void loadUploads()}>
                {uploadsLoading() ? "Loading…" : "Refresh"}
              </button>
            </div>
            <Show when={uploadsError()}>
              <p class="roles-error" role="alert">
                {uploadsError()}
              </p>
            </Show>
            <Show when={uploads()} fallback={<p class="modal-text">Loading…</p>}>
              {(u) => (
                <>
                  <p class="modal-text">
                    {u().totalCount} file{u().totalCount === 1 ? "" : "s"}, {formatBytes(u().totalBytes)}
                    {u().capped ? " (first 5,000 scanned)" : ""}.
                  </p>
                  <div class="dashboard-bars">
                    <For each={u().byCategory}>
                      {(c) => (
                        <div class="dashboard-bar-row">
                          <span class="dashboard-bar-label">{c.category}</span>
                          <div class="dashboard-bar-track">
                            <div class="dashboard-bar-fill" style={{ width: `${(c.bytes / Math.max(1, u().byCategory[0]?.bytes ?? 1)) * 100}%` }} />
                          </div>
                          <span class="dashboard-bar-count">{formatBytes(c.bytes)}</span>
                        </div>
                      )}
                    </For>
                  </div>
                  <h3 class="dashboard-subhead">Most recent</h3>
                  <div class="people-list find-list dashboard-people">
                    <For each={u().recent} fallback={<p class="modal-text">No uploads yet.</p>}>
                      {(f) => (
                        <div class="person">
                          <span class="member-name">{f.pathname.split("/").pop()}</span>
                          <span class="dashboard-pill">{f.category}</span>
                          <span class="dashboard-where">{formatBytes(f.size)}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </>
              )}
            </Show>
          </section>

          <section id="dashboard-section-feedback" class="dashboard-section">
            <h2 class="dashboard-title">Feedback</h2>
            <p class="modal-text">Everyone's bug reports and ideas. Reply and they see it in their own Feedback.</p>
            <div class="dashboard-bounded">
              <Inbox by={props.username || props.name} />
            </div>
          </section>

          <section id="dashboard-section-audit" class="dashboard-section">
            <h2 class="dashboard-title">Audit log</h2>
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
                              <Show when={e.count > 1}>
                                <span class="dashboard-audit-count"> ×{e.count}</span>
                              </Show>
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </section>
        </div>
        </div>
        </Show>

        <Show when={page() === "tools"}>
          <div class="dashboard-tools-row">
            <section class="dashboard-section dashboard-tools-col">
              <h1 class="dashboard-title">Oversight</h1>
              <OversightBody profiles={props.profiles} />
            </section>

            <section class="dashboard-section dashboard-tools-col">
              <h2 class="dashboard-title">Activity</h2>
              <div class="dashboard-activity-head">
                <p class="modal-text">Who committed, pushed and deployed what.</p>
                <a class="dashboard-link" href={`${import.meta.env.BASE_URL}activity.html`} target="_blank" rel="noopener">
                  Open in its own tab ↗
                </a>
              </div>
              <iframe class="dashboard-activity-frame" src={`${import.meta.env.BASE_URL}activity.html?embed`} title="Activity" />
            </section>
          </div>

          <section class="dashboard-section">
            <h2 class="dashboard-title">Live calls</h2>
            <p class="modal-text">Every videochat and 3D room running right now, across every server.</p>
            <Show when={roomsError()}>
              <p class="roles-error" role="alert">
                {roomsError()}
              </p>
            </Show>
            <Show when={liveRooms()} fallback={<p class="modal-text">Loading…</p>}>
              <For each={liveRooms()} fallback={<p class="modal-text">Nobody is in a call right now.</p>}>
                {(r) => (
                  <div class="dashboard-room">
                    <div class="dashboard-room-head">
                      <span class="member-name">
                        {servers()?.find((s) => s.id === r.serverId)?.name ?? r.serverId}
                        <small>{r.is3dRoom ? "3D room" : "videochat"}</small>
                      </span>
                      <span class="dashboard-pill">{r.numParticipants} in call</span>
                      <button class="btn" type="button" disabled={roomBusy().has(r.name)} onClick={() => void endCall(r.name)}>
                        End call
                      </button>
                    </div>
                    <div class="people-list dashboard-people">
                      <For each={r.participants}>
                        {(p) => (
                          <div class="person">
                            <span class="avatar small" style={faceStyle(props.profiles.get(p.identity))}>
                              {faceText(props.profiles.get(p.identity), nameOf(p.identity))}
                            </span>
                            <span class="member-name">{nameOf(p.identity)}</span>
                            <span class={`dashboard-pill quality-${p.connectionQuality.toLowerCase()}`}>{p.connectionQuality.toLowerCase()}</span>
                            <span class="dashboard-where">{p.audioMuted ? "mic off" : "mic on"} · {p.videoMuted ? "cam off" : "cam on"}</span>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </section>
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
