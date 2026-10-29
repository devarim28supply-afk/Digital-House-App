import { type Unsubscribe, addDoc, collection, limit, onSnapshot, orderBy, query, serverTimestamp } from "firebase/firestore";

import { auth, db } from "../firebase";

/*
 * The action log: who did what inside Darkwood Node (rules:
 * M2A-Access-Control/firestore.rules, auditlog):
 *
 *   auditlog/{id}   uid, action, serverId?, target?, detail?, at
 *
 * Written by the person doing it, as they do it (a tile made or deleted, a
 * server renamed, someone added, another person's message deleted, a member
 * approved...). Only the owner, admins and developers read it, on the
 * Activity page. Nobody edits or deletes an entry.
 */

export type AuditAction =
  | "server.create"
  | "server.delete"
  | "server.settings"
  | "server.rename"
  | "server.open"
  | "server.invite"
  | "member.add"
  | "member.remove"
  | "member.role"
  | "member.approve"
  | "member.deny"
  | "tile.create"
  | "tile.delete"
  | "tile.picture"
  | "channel.create"
  | "channel.rename"
  | "channel.delete"
  | "message.delete"
  | "call.remove"
  | "oversight.view"
  | "emoji.add"
  | "emoji.delete";

export type AuditEntry = {
  id: string;
  uid: string;
  action: string;
  serverId?: string;
  target?: string;
  detail?: string;
  at: number;
};

/** Plain-language label for each action, for the Activity page and the Dashboard. */
export const ACTION_LABEL: Record<AuditAction, string> = {
  "server.create": "made a server",
  "server.delete": "deleted a server",
  "server.settings": "changed server settings",
  "server.rename": "renamed a server",
  "server.open": "changed who a server is open to",
  "server.invite": "made an invite code",
  "member.add": "added a member",
  "member.remove": "removed a member",
  "member.role": "changed a role",
  "member.approve": "approved a member",
  "member.deny": "denied a member",
  "tile.create": "made a tile",
  "tile.delete": "deleted a tile",
  "tile.picture": "changed a tile's picture",
  "channel.create": "made a channel",
  "channel.rename": "renamed a channel",
  "channel.delete": "deleted a channel",
  "message.delete": "deleted a message",
  "call.remove": "removed someone from a call",
  "oversight.view": "looked into a server",
  "emoji.add": "added an emoji",
  "emoji.delete": "deleted an emoji",
};

/** Note an action. Never in the way: a failed note is dropped quietly. */
export function audit(action: AuditAction, info: { serverId?: string; target?: string; detail?: string } = {}) {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const entry: Record<string, unknown> = { uid, action, at: serverTimestamp() };
  if (info.serverId) entry.serverId = info.serverId;
  if (info.target) entry.target = info.target.slice(0, 200);
  if (info.detail) entry.detail = info.detail.slice(0, 300);
  void addDoc(collection(db, "auditlog"), entry).catch(() => {});
}

/** The newest actions (owner, admins and developers only). */
export function watchAudit(cb: (entries: AuditEntry[]) => void, onError?: (err: Error) => void): Unsubscribe {
  return onSnapshot(
    query(collection(db, "auditlog"), orderBy("at", "desc"), limit(300)),
    (snap) =>
      cb(
        snap.docs.map((d) => {
          const x = d.data();
          return {
            id: d.id,
            uid: String(x.uid ?? ""),
            action: String(x.action ?? ""),
            serverId: x.serverId,
            target: x.target,
            detail: x.detail,
            at: x.at?.toMillis?.() ?? Date.now(),
          };
        }),
      ),
    (err) => onError?.(err),
  );
}
