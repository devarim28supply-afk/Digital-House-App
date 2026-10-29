import { type Unsubscribe, addDoc, collection, limit, onSnapshot, orderBy, query, serverTimestamp } from "firebase/firestore";

import { db } from "../firebase";

/*
 * Staff Chat: a live group chat for staff only (rules:
 * M2A-Access-Control/firestore.rules, staffchat):
 *
 *   staffchat/{id}   uid, text, at
 *
 * A flat collection, not a server/channel - it lives in the Dashboard, not
 * the sidebar, so nobody who isn't staff ever sees it exists. No edit or
 * delete in this first pass, same as the audit log's own simplicity.
 */

export type StaffMessage = {
  id: string;
  uid: string;
  text: string;
  at: number;
};

export function sendStaffMessage(uid: string, text: string) {
  const body = text.trim().slice(0, 2000);
  if (!body) return;
  return addDoc(collection(db, "staffchat"), { uid, text: body, at: serverTimestamp() });
}

/** The newest messages, oldest first for display (staff only). */
export function watchStaffChat(cb: (messages: StaffMessage[]) => void, onError?: (err: Error) => void): Unsubscribe {
  return onSnapshot(
    query(collection(db, "staffchat"), orderBy("at", "desc"), limit(200)),
    (snap) =>
      cb(
        snap.docs
          .map((d) => {
            const x = d.data();
            return { id: d.id, uid: String(x.uid ?? ""), text: String(x.text ?? ""), at: x.at?.toMillis?.() ?? Date.now() };
          })
          .reverse(),
      ),
    (err) => onError?.(err),
  );
}
