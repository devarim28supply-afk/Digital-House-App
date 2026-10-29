import { doc, updateDoc } from "firebase/firestore";
import { For, Show, createMemo, createSignal, onMount } from "solid-js";

import { audit } from "../data/audit";
import { type Profile, displayName } from "../data/store";
import { access, db } from "../firebase";
import { Modal } from "./Modal";
import { faceStyle, faceText } from "./Shell";
import "./roles.css";

/*
 * Roles: the owner hands out Staff, Admin and Developer (members/{uid}.roles.
 * staff / .admin / .develop; M2A-Access-Control's rules let staff write
 * them). Staff reach every server — approvals, suspends, bans, feedback,
 * oversight. Admin runs only the server(s) they already belong to. A
 * Developer counts as staff too. Only approved members are listed, and your
 * own row is locked so you cannot take your own role.
 */

type Role = "staff" | "admin" | "develop";
type Row = {
  uid: string;
  name?: string;
  username?: string;
  email?: string;
  status?: string;
  roles?: Partial<Record<Role, boolean>>;
};

const LABEL: Record<Role, string> = { staff: "Staff", admin: "Admin", develop: "Developer" };

export function RolesDialog(props: { open: boolean; onClose: () => void; uid: string; profiles: Map<string, Profile> }) {
  return (
    <Modal title="Roles" class="roles-modal" open={props.open} onClose={props.onClose}>
      <RolesBody uid={props.uid} profiles={props.profiles} />
    </Modal>
  );
}

function RolesBody(props: { uid: string; profiles: Map<string, Profile> }) {
  const [rows, setRows] = createSignal<Row[] | undefined>();
  const [error, setError] = createSignal("");
  const [q, setQ] = createSignal("");
  const [busy, setBusy] = createSignal(new Set<string>());
  const [ask, setAsk] = createSignal<{ row: Row; role: Role; on: boolean } | undefined>();

  const nameOf = (r: Row) => displayName(props.profiles.get(r.uid), r.name || r.username || "Member");

  onMount(async () => {
    try {
      const all = (await access.admin.listMembers()) as Row[];
      setRows(all.filter((r) => r.status === "approved").sort((a, b) => nameOf(a).localeCompare(nameOf(b))));
    } catch {
      setError("Could not load the members. Only admins can see them.");
      setRows([]);
    }
  });

  const shown = createMemo(() => {
    const term = q().trim().toLowerCase();
    return (rows() ?? []).filter((r) => !term || `${nameOf(r)} ${r.username ?? ""}`.toLowerCase().includes(term));
  });

  async function setRole(row: Row, role: Role, on: boolean) {
    if (busy().has(row.uid)) return;
    setError("");
    setBusy((prev) => new Set(prev).add(row.uid));
    try {
      // only this one role changes; the person's other roles stay as they are
      await updateDoc(doc(db, "members", row.uid), { [`roles.${role}`]: on });
      setRows((prev) => prev?.map((r) => (r.uid === row.uid ? { ...r, roles: { ...r.roles, [role]: on } } : r)));
      audit("member.role", { target: nameOf(row), detail: `${on ? "+" : "-"} ${role}` });
    } catch {
      setError(`Could not change ${nameOf(row)}. The database refused it.`);
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(row.uid);
        return next;
      });
    }
  }

  // Staff and Admin are the strong ones: ask first. Developer goes straight through.
  const toggle = (row: Row, role: Role) => {
    const on = !row.roles?.[role];
    if (role === "staff" || role === "admin") setAsk({ row, role, on });
    else void setRole(row, role, on);
  };

  return (
    <>
      <p class="modal-text">
        Staff reach every server — approvals, suspending, banning, oversight, and feedback. Admin runs only the
        server(s) they already belong to. Developers count as staff too.
      </p>
      <Show when={ask()}>
        {(a) => (
          <div class="roles-confirm" role="alertdialog" aria-label={`Confirm ${a().role} change`}>
            <p class="modal-text">
              {a().on ? `Make ${nameOf(a().row)} ${LABEL[a().role]}?` : `Take ${LABEL[a().role]} away from ${nameOf(a().row)}?`}
            </p>
            <div class="modal-actions">
              <button
                class="btn"
                type="button"
                onClick={() => {
                  const { row, role, on } = a();
                  setAsk(undefined);
                  void setRole(row, role, on);
                }}
              >
                Yes
              </button>
              <button class="btn" type="button" onClick={() => setAsk(undefined)}>
                No
              </button>
            </div>
          </div>
        )}
      </Show>
      <input
        class="roles-search"
        type="search"
        placeholder="Find a member"
        aria-label="Find a member"
        value={q()}
        onInput={(e) => setQ(e.currentTarget.value)}
      />
      <Show when={error()}>
        <p class="roles-error" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={rows()} fallback={<p class="modal-text">Loading…</p>}>
        <div class="people-list roles-list">
          <For each={shown()} fallback={<p class="modal-text">No approved members found.</p>}>
            {(r) => (
              <div class="person">
                <span class="avatar small" style={faceStyle(props.profiles.get(r.uid))}>
                  {faceText(props.profiles.get(r.uid), nameOf(r))}
                </span>
                <span class="member-name">
                  {nameOf(r)} <small>@{r.username || "member"}</small>
                </span>
                <For each={["staff", "admin", "develop"] as Role[]}>
                  {(role) => (
                    <button
                      class="btn role-toggle"
                      type="button"
                      aria-pressed={Boolean(r.roles?.[role])}
                      disabled={busy().has(r.uid) || r.uid === props.uid}
                      title={r.uid === props.uid ? "You cannot change your own roles" : undefined}
                      onClick={() => toggle(r, role)}
                    >
                      {LABEL[role]}
                    </button>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}
