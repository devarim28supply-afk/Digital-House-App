import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import { ACTION_LABEL, type AuditEntry, audit, watchAudit } from "../data/audit";
import { availabilityStatus } from "../data/status";
import { type Profile, type Server, ONLINE_WINDOW_MS, displayName, watchAllServers, watchPresence } from "../data/store";
import { access } from "../firebase";
import { faceStyle, faceText } from "./Shell";
import "./dashboard.css";

/*
 * Dashboard: staff's one place to see how Darkwood Node is doing right now —
 * join requests, every member's standing (approve, deny, suspend, ban,
 * restore), who is online and where, every server's size, and the live audit
 * trail. Calls the same access.admin methods the bunker's own admin panel
 * uses (members/{uid}.status and .roles — M2A-Access-Control's rules let
 * staff write them). Nothing here is new data: it is Roles' members list,
 * Oversight's server list, presence, and the audit log, brought together and
 * kept live.
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

type Tab = "overview" | "members" | "online" | "servers" | "audit";
type Confirm = { row: MemberRow; status: Status; label: string };

export function DashboardDialog(props: { open: boolean; onClose: () => void; profiles: Map<string, Profile> }) {
  return (
    <Show when={props.open}>
      <DashboardScreen onClose={props.onClose} profiles={props.profiles} />
    </Show>
  );
}

function DashboardScreen(props: { onClose: () => void; profiles: Map<string, Profile> }) {
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
      <div class="dashboard-screen-body">
        <DashboardBody profiles={props.profiles} />
      </div>
    </div>
  );
}

function DashboardBody(props: { profiles: Map<string, Profile> }) {
  const [tab, setTab] = createSignal<Tab>("overview");
  const [members, setMembers] = createSignal<MemberRow[] | undefined>();
  const [membersError, setMembersError] = createSignal("");
  const [busy, setBusy] = createSignal(new Set<string>());
  const [servers, setServers] = createSignal<Server[] | undefined>();
  const [serversError, setServersError] = createSignal("");
  const [presence, setPresence] = createSignal<Map<string, import("../data/store").Presence>>(new Map());
  const [entries, setEntries] = createSignal<AuditEntry[]>([]);
  const [now, setNow] = createSignal(Date.now());

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

  onMount(() => {
    void loadMembers();
    const stopServers = watchAllServers(setServers, () => setServersError("Could not load the servers."));
    const stopPresence = watchPresence(setPresence);
    const stopAudit = watchAudit(setEntries);
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    onCleanup(() => {
      stopServers();
      stopPresence();
      stopAudit();
      window.clearInterval(tick);
    });
  });

  const approved = createMemo(() => members()?.filter((m) => m.status === "approved") ?? []);
  const pending = createMemo(() => members()?.filter((m) => m.status === "pending") ?? []);
  const denied = createMemo(() => members()?.filter((m) => m.status === "denied") ?? []);
  const suspended = createMemo(() => members()?.filter((m) => m.status === "suspended") ?? []);
  const banned = createMemo(() => members()?.filter((m) => m.status === "banned") ?? []);
  const staffMembers = createMemo(() => approved().filter((m) => m.roles?.staff || m.roles?.develop));
  const admins = createMemo(() => approved().filter((m) => m.roles?.admin));
  const developers = createMemo(() => approved().filter((m) => m.roles?.develop));

  const isOnline = (uid: string) => {
    const p = presence().get(uid);
    if (!p) return false;
    return availabilityStatus(props.profiles.get(uid)?.availability) !== "invisible" && now() - p.lastSeen < ONLINE_WINDOW_MS;
  };
  const online = createMemo(() => approved().filter((m) => isOnline(m.uid)));

  const recent24h = createMemo(() => entries().filter((e) => now() - e.at < 24 * 60 * 60_000));
  const topActions = createMemo(() => {
    const counts = new Map<string, number>();
    for (const e of recent24h()) counts.set(e.action, (counts.get(e.action) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  });
  const maxTopCount = createMemo(() => Math.max(1, ...topActions().map((t) => t[1])));

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

  const TABS: { id: Tab; label: string; badge?: () => number }[] = [
    { id: "overview", label: "Overview" },
    { id: "members", label: "Members", badge: () => pending().length },
    { id: "online", label: "Online", badge: () => online().length },
    { id: "servers", label: "Servers" },
    { id: "audit", label: "Audit log" },
  ];

  return (
    <div class="dashboard">
      <div class="dashboard-tabs" role="tablist">
        <For each={TABS}>
          {(t) => (
            <button
              type="button"
              class="dashboard-tab"
              role="tab"
              aria-selected={tab() === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              <Show when={t.badge && t.badge() > 0}>
                <span class="dashboard-badge">{t.badge?.()}</span>
              </Show>
            </button>
          )}
        </For>
      </div>

      <Show when={tab() === "overview"}>
        <div class="dashboard-stats">
          <StatTile label="Servers" value={servers()?.length ?? "…"} />
          <StatTile label="Approved members" value={approved().length || (members() ? 0 : "…")} />
          <StatTile label="Online now" value={online().length} />
          <StatTile label="Pending" value={pending().length} warn={pending().length > 0} />
          <StatTile label="Staff" value={staffMembers().length} />
          <StatTile label="Admins" value={admins().length} />
          <StatTile label="Developers" value={developers().length} />
          <StatTile label="Suspended" value={suspended().length} warn={suspended().length > 0} />
          <StatTile label="Banned" value={banned().length} warn={banned().length > 0} />
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
      </Show>

      <Show when={tab() === "members"}>
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
          <div class="people-list find-list">
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
          <div class="people-list find-list">
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
                    <span class="dashboard-chip">Staff</span>
                  </Show>
                  <Show when={row.roles?.admin}>
                    <span class="dashboard-chip">Admin</span>
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
            <h3 class="dashboard-subhead">Suspended ({suspended().length})</h3>
            <div class="people-list find-list">
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
          </Show>

          <Show when={banned().length}>
            <h3 class="dashboard-subhead">Banned ({banned().length})</h3>
            <div class="people-list find-list">
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
          </Show>

          <Show when={denied().length}>
            <h3 class="dashboard-subhead">Denied ({denied().length})</h3>
            <div class="people-list find-list">
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
          </Show>
        </Show>
      </Show>

      <Show when={tab() === "online"}>
        <div class="people-list find-list">
          <For each={online()} fallback={<p class="modal-text">Nobody is online.</p>}>
            {(row) => (
              <div class="person">
                <span class="avatar small" style={faceStyle(props.profiles.get(row.uid))}>
                  {faceText(props.profiles.get(row.uid), nameOf(row.uid, row))}
                </span>
                <span class="member-name">{nameOf(row.uid, row)}</span>
                <span class="dashboard-where">{presence().get(row.uid)?.where || "—"}</span>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={tab() === "servers"}>
        <Show when={serversError()}>
          <p class="roles-error" role="alert">
            {serversError()}
          </p>
        </Show>
        <div class="people-list find-list">
          <Show when={servers()} fallback={<p class="modal-text">Loading…</p>}>
            <For each={servers()} fallback={<p class="modal-text">No servers.</p>}>
              {(s) => (
                <div class="person">
                  <span class="member-name">{s.name}</span>
                  <span class="dashboard-chip">{s.memberUids.length} member{s.memberUids.length === 1 ? "" : "s"}</span>
                  <span class="dashboard-chip">{s.open ? "Open" : "Invite only"}</span>
                  <span class="dashboard-where">owner: {nameOf(s.ownerUid)}</span>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>

      <Show when={tab() === "audit"}>
        <div class="dashboard-audit find-list">
          <For each={entries().slice(0, 100)} fallback={<p class="modal-text">Nothing logged yet.</p>}>
            {(e) => (
              <div class="dashboard-audit-row">
                <time>{new Date(e.at).toLocaleString()}</time>
                <span>
                  <b>{nameOf(e.uid)}</b> {ACTION_LABEL[e.action as keyof typeof ACTION_LABEL] ?? e.action}
                  <Show when={e.target}> — {e.target}</Show>
                  <Show when={e.detail}> ({e.detail})</Show>
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function StatTile(props: { label: string; value: number | string; warn?: boolean }) {
  return (
    <div class="dashboard-tile" classList={{ warn: props.warn }}>
      <span class="dashboard-tile-value">{props.value}</span>
      <span class="dashboard-tile-label">{props.label}</span>
    </div>
  );
}
