import { createUserWithEmailAndPassword, sendEmailVerification, updateProfile } from "firebase/auth";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";

import { auth, db } from "../firebase";

/**
 * Open sign-up for Darkwood Node. Anyone can register with a REAL email; Firebase sends the verification link, and the
 * account is in once the email is verified (no operator approval). The account is separate from the operator-approved
 * members that the other rooms use: it has a dhMembers/{uid} record, and nothing else in the project opens for it.
 */

const PENDING_KEY = "dh_pending_profile";

export type DhMember = { uid: string; name: string; username: string; email: string };

export const normalizeUsername = (raw: string) =>
  String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "")
    .slice(0, 24);

export class DhError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function friendly(err: unknown): DhError {
  if (err instanceof DhError) return err;
  const code = (err as { code?: string } | null)?.code ?? "";
  if (code.includes("email-already-in-use")) return new DhError("taken-email", "That email already has an account. Log in instead.");
  if (code.includes("invalid-email")) return new DhError("invalid", "That email address is not valid.");
  if (code.includes("weak-password")) return new DhError("weak", "Choose a longer password (6 or more characters).");
  if (code.includes("too-many-requests")) return new DhError("throttled", "Too many tries. Wait a moment and try again.");
  if (code.includes("network-request-failed")) return new DhError("offline", "No connection. Check your internet and try again.");
  if (code.includes("permission-denied")) return new DhError("denied", "That was refused. If you just verified your email, wait a few seconds and try again.");
  return new DhError(code || "unknown", "Something went wrong. Try again.");
}

function savePending(profile: { name: string; username: string }) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(profile));
  } catch {
    /* private window: the profile step asks again */
  }
}
function readPending(): { name: string; username: string } | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as { name: string; username: string }) : null;
  } catch {
    return null;
  }
}
function clearPending() {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    /* nothing saved */
  }
}

/** Make the account and send the verification email. The app then shows "check your email". */
export async function registerDhAccount(input: { name: string; username: string; email: string; password: string }) {
  const name = input.name.trim().slice(0, 60);
  const username = normalizeUsername(input.username);
  const email = input.email.trim().toLowerCase();
  if (!name) throw new DhError("missing", "Enter your name.");
  if (username.length < 3) throw new DhError("invalid", "Username: 3 to 24 letters, digits, _ . -");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new DhError("invalid", "That email address is not valid.");
  if (input.password.length < 6) throw new DhError("weak", "Choose a longer password (6 or more characters).");
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, input.password);
    await updateProfile(cred.user, { displayName: name }).catch(() => undefined);
    savePending({ name, username });
    await sendEmailVerification(cred.user);
  } catch (err) {
    throw friendly(err);
  }
}

export async function resendVerification() {
  const user = auth.currentUser;
  if (!user) throw new DhError("signedout", "Log in first.");
  try {
    await sendEmailVerification(user);
  } catch (err) {
    throw friendly(err);
  }
}

/** Ask Firebase again whether the email has been verified, and refresh the login so the database sees it. */
export async function checkEmailVerified(): Promise<boolean> {
  const user = auth.currentUser;
  if (!user) return false;
  await user.reload();
  if (!user.emailVerified) return false;
  await user.getIdToken(true);
  return true;
}

export async function loadDhMember(uid: string): Promise<DhMember | null> {
  try {
    const snap = await getDoc(doc(db, "dhMembers", uid));
    if (!snap.exists()) return null;
    const d = snap.data();
    return { uid, name: String(d.name ?? ""), username: String(d.username ?? ""), email: String(d.email ?? "") };
  } catch {
    return null;
  }
}

/** The verified person becomes a member: claim the username, then write the record (the rules check both). */
export async function createDhMember(profile?: { name: string; username: string }): Promise<DhMember> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified || !user.email) throw new DhError("unverified", "Verify your email first.");
  const picked = profile ?? readPending();
  if (!picked) throw new DhError("noprofile", "Choose your name and username.");
  const name = picked.name.trim().slice(0, 60);
  const username = normalizeUsername(picked.username);
  if (!name || username.length < 3) throw new DhError("invalid", "Enter your name and a username of 3 to 24 letters, digits, _ . -");
  try {
    await setDoc(doc(db, "dhUsernames", username), { uid: user.uid });
  } catch (err) {
    // a name that is already claimed cannot be written again; claiming it for yourself twice is fine
    const code = (err as { code?: string } | null)?.code ?? "";
    if (code.includes("permission-denied")) {
      const existing = await getDoc(doc(db, "dhUsernames", username)).catch(() => null);
      if (!existing?.exists() || existing.data()?.uid !== user.uid) throw new DhError("taken-username", "That username is taken. Choose another.");
    } else {
      throw friendly(err);
    }
  }
  try {
    await setDoc(doc(db, "dhMembers", user.uid), { uid: user.uid, name, username, email: user.email, createdAt: serverTimestamp() });
  } catch (err) {
    throw friendly(err);
  }
  clearPending();
  return { uid: user.uid, name, username, email: user.email };
}
