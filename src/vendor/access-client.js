// M2A Access Control: the shared client.
//
// One module, embedded by every room that gates something on membership, and
// by the admin panel. It wraps Firebase email/password auth and the
// members/{uid} registry with a small state machine:
//
//   guest  ->  (register)  ->  pending  ->  approved | denied
//                             (login)   ->  approved | pending | denied | unregistered
//
// Usernames: Firebase Auth signs in with an email, so a username becomes the
// synthetic address <username>@m2a-access.local. The real email lives on the
// member record for the admin to see. Anyone who registered with a real email
// on an older screen can still log in by typing that email instead.
//
// The approved state is mirrored to localStorage under MEMBER_KEY, which is
// what the room door gates already read.
import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  collection,
  getDocs,
  serverTimestamp,
} from "firebase/firestore";

export const MEMBER_KEY = "gestrlab_member";
export const LOGIN_DOMAIN = "m2a-access.local";
export const STATUSES = ["guest", "pending", "approved", "denied", "unregistered"];

export class AccessError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function normalizeUsername(raw) {
  return String(raw || "").trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 24);
}

// What the person typed at the USERNAME prompt, turned into the address
// Firebase Auth knows them by.
export function loginEmailFor(idOrEmail) {
  const s = String(idOrEmail || "").trim();
  if (s.includes("@")) return s.toLowerCase();
  const u = normalizeUsername(s);
  return u ? u + "@" + LOGIN_DOMAIN : "";
}

export function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
}

function friendly(err) {
  const c = (err && err.code) || "";
  if (c.includes("email-already-in-use")) return new AccessError("taken", "That username is already taken.");
  if (c.includes("invalid-email")) return new AccessError("invalid", "That username or email is not valid.");
  if (c.includes("wrong-password") || c.includes("invalid-credential") || c.includes("invalid-login-credentials"))
    return new AccessError("badlogin", "Wrong username or password.");
  if (c.includes("user-not-found")) return new AccessError("nouser", "No account with that name. Register first.");
  if (c.includes("too-many-requests")) return new AccessError("throttled", "Too many attempts. Wait a moment.");
  if (c.includes("weak-password")) return new AccessError("weak", "Password is too weak (6+ characters).");
  if (c.includes("permission-denied")) return new AccessError("denied", "The registry refused that. Rules not published?");
  if (c.includes("network-request-failed")) return new AccessError("offline", "No connection to the registry.");
  return new AccessError(c || "unknown", "ERROR: " + (c || (err && err.message) || "unknown"));
}

export function createAccessClient({ firebaseConfig, ownerEmail, app: givenApp } = {}) {
  const app = givenApp || (getApps().length ? getApp() : initializeApp(firebaseConfig));
  const auth = getAuth(app);
  const db = getFirestore(app);
  const owner = String(ownerEmail || "").toLowerCase();

  let state = { status: "guest", user: null, member: null, admin: false, error: null };
  const listeners = new Set();
  let unsubMember = null;
  let busy = false; // a login/register drives the flow by hand; the auth listener stays out

  function pack(user) {
    return { uid: user.uid, loginEmail: user.email || "", displayName: user.displayName || "" };
  }

  function mirror() {
    try {
      if (state.status === "approved" && state.user) {
        const m = state.member || {};
        localStorage.setItem(
          MEMBER_KEY,
          JSON.stringify({
            uid: state.user.uid,
            email: m.email || state.user.loginEmail,
            username: m.username || "",
            name: m.name || "",
            admin: Boolean(state.admin),
          }),
        );
      } else {
        localStorage.removeItem(MEMBER_KEY);
      }
    } catch {
      /* private mode: the door gate just will not persist */
    }
  }

  function setState(next) {
    state = { ...state, ...next };
    mirror();
    for (const fn of listeners) {
      try {
        fn(state);
      } catch {
        /* a listener must not break the others */
      }
    }
  }

  function applyMember(user, snap) {
    const isOwner = String(user.email || "").toLowerCase() === owner && owner !== "";
    if (!snap.exists()) {
      setState({ status: "unregistered", user: pack(user), member: null, admin: isOwner, error: null });
      return;
    }
    const m = snap.data();
    const admin = isOwner || Boolean(m.roles && m.roles.admin);
    const status = m.status === "approved" ? "approved" : m.status === "denied" ? "denied" : "pending";
    setState({ status, user: pack(user), member: m, admin, error: null });
  }

  function watchMember(user) {
    if (unsubMember) unsubMember();
    unsubMember = onSnapshot(
      doc(db, "members", user.uid),
      (snap) => applyMember(user, snap),
      (err) => setState({ status: "error", error: friendly(err).message }),
    );
  }

  async function resolveMember(user) {
    const ref = doc(db, "members", user.uid);
    let snap = await getDoc(ref);
    // Owner bootstrap: the very first login on a fresh project has no record
    // yet, and only the owner may write an approved one.
    if (!snap.exists() && owner && String(user.email || "").toLowerCase() === owner) {
      await setDoc(ref, {
        uid: user.uid,
        name: user.displayName || "Operator",
        username: "operator",
        email: user.email,
        loginEmail: user.email,
        status: "pending",
        roles: {},
        createdAt: serverTimestamp(),
      });
      await updateDoc(ref, { status: "approved", roles: { admin: true } });
      snap = await getDoc(ref);
    }
    applyMember(user, snap);
    watchMember(user);
    return state;
  }

  onAuthStateChanged(auth, (user) => {
    if (busy) return;
    if (!user) {
      if (unsubMember) unsubMember();
      unsubMember = null;
      setState({ status: "guest", user: null, member: null, admin: false, error: null });
      return;
    }
    resolveMember(user).catch((err) => setState({ status: "error", error: friendly(err).message }));
  });

  async function login(id, password) {
    const email = loginEmailFor(id);
    if (!email || !password) throw new AccessError("missing", "Enter a username and password.");
    busy = true;
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      return await resolveMember(cred.user);
    } catch (err) {
      throw err instanceof AccessError ? err : friendly(err);
    } finally {
      busy = false;
    }
  }

  async function register({ fullName, email, username, password } = {}) {
    const name = String(fullName || "").trim().slice(0, 60);
    const un = normalizeUsername(username);
    const em = String(email || "").trim().toLowerCase();
    if (!name) throw new AccessError("missing", "Full name is required.");
    if (!isValidEmail(em)) throw new AccessError("invalid", "That email address is not valid.");
    if (un.length < 3) throw new AccessError("invalid", "Username: 3 to 24 letters, digits, _ . -");
    if (String(password || "").length < 6) throw new AccessError("weak", "Password must be at least 6 characters.");
    busy = true;
    try {
      const cred = await createUserWithEmailAndPassword(auth, un + "@" + LOGIN_DOMAIN, password);
      const user = cred.user;
      try {
        await updateProfile(user, { displayName: name });
      } catch {
        /* cosmetic */
      }
      await setDoc(doc(db, "members", user.uid), {
        uid: user.uid,
        name,
        username: un,
        email: em,
        loginEmail: user.email,
        status: "pending",
        roles: {},
        createdAt: serverTimestamp(),
        requestedFrom: typeof location !== "undefined" ? location.host : "",
      });
      return await resolveMember(user);
    } catch (err) {
      throw err instanceof AccessError ? err : friendly(err);
    } finally {
      busy = false;
    }
  }

  async function logout() {
    if (unsubMember) unsubMember();
    unsubMember = null;
    await signOut(auth);
    setState({ status: "guest", user: null, member: null, admin: false, error: null });
  }

  async function refresh() {
    const user = auth.currentUser;
    if (!user) return state;
    return resolveMember(user);
  }

  // ---- admin side (rules only let an admin do these) ----------------------
  async function listMembers() {
    const snap = await getDocs(collection(db, "members"));
    const rows = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    const t = (r) => (r.createdAt && r.createdAt.toMillis ? r.createdAt.toMillis() : 0);
    rows.sort((a, b) => t(b) - t(a));
    return rows;
  }
  function setStatus(uid, status) {
    if (!["approved", "denied", "pending"].includes(status)) throw new AccessError("invalid", "Bad status.");
    return updateDoc(doc(db, "members", uid), {
      status,
      reviewedAt: serverTimestamp(),
      reviewedBy: auth.currentUser ? auth.currentUser.uid : null,
    });
  }
  function setRoles(uid, roles) {
    return updateDoc(doc(db, "members", uid), { roles: roles || {} });
  }

  return {
    login,
    register,
    logout,
    refresh,
    getState: () => state,
    onChange(fn) {
      listeners.add(fn);
      fn(state);
      return () => listeners.delete(fn);
    },
    isApproved: () => state.status === "approved",
    isAdmin: () => Boolean(state.admin) && state.status === "approved",
    admin: { listMembers, approve: (uid) => setStatus(uid, "approved"), deny: (uid) => setStatus(uid, "denied"), reset: (uid) => setStatus(uid, "pending"), setRoles },
    auth,
    db,
    app,
  };
}