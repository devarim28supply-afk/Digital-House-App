import { getApp, getApps, initializeApp } from "firebase/app";
import type { Auth } from "firebase/auth";
import { type Firestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";

import { firebaseConfig, OWNER_EMAIL } from "./firebase-config.js";
import { createAccessClient } from "./vendor/access-client.js";

/**
 * One Firebase app for everything: the shared access client (members,
 * approval) owns it, and the chat data rides the same Firestore.
 */
/**
 * Firestore keeps a local copy of what it has read (shared between tabs), so a
 * reload or a reconnect only pays for what changed, not for every profile and
 * presence document again. If the cache cannot start (private window, old
 * browser) Firestore falls back to the plain in-memory one.
 */
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
try {
  initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
} catch {
  /* already started elsewhere, or no local storage: getFirestore() below picks what exists */
}
export const access = createAccessClient({ firebaseConfig, ownerEmail: OWNER_EMAIL, app });
export const db = access.db as Firestore;
export const auth = access.auth as Auth;

export type AccessStatus = "guest" | "pending" | "approved" | "denied" | "unregistered" | "error";

export type AccessState = {
  status: AccessStatus;
  user: { uid: string; loginEmail: string; displayName: string } | null;
  member: { name?: string; username?: string; email?: string; roles?: Record<string, boolean> } | null;
  admin: boolean;
  error: string | null;
};
