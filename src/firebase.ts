import type { Auth } from "firebase/auth";
import type { Firestore } from "firebase/firestore";

import { firebaseConfig, OWNER_EMAIL } from "./firebase-config.js";
import { createAccessClient } from "./vendor/access-client.js";

/**
 * One Firebase app for everything: the shared access client (members,
 * approval) owns it, and the chat data rides the same Firestore.
 */
export const access = createAccessClient({ firebaseConfig, ownerEmail: OWNER_EMAIL });
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
