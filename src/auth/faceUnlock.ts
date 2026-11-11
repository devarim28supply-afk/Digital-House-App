/**
 * Face unlock, on this phone only.
 *
 * The phone's own Face ID / Android face unlock does the check (WebAuthn,
 * userVerification "required"). The app never sees a face. The check yields a
 * secret (the WebAuthn PRF extension) that locks the saved login in
 * localStorage, so nothing readable is stored. No secret, no login.
 *
 * Needs PRF: iPhone iOS 18+, Android Chrome. Elsewhere `faceUnlockSupported()`
 * is false and the login screen shows no face button.
 */

const KEY = "dh_face_unlock_v1";
const DISMISS = "dh_face_unlock_offer_off";
const SALT = new TextEncoder().encode("darkwood-node face unlock v1");

type Saved = { cred: string; iv: string; data: string };

const b64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64 = (text: string) => {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

function read(): Saved | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

let platformOk: boolean | null = null;
/** Can this phone do face / biometric unlock at all? (Answer cached after the first call.) */
export async function faceUnlockSupported(): Promise<boolean> {
  if (platformOk !== null) return platformOk;
  try {
    platformOk =
      window.isSecureContext &&
      typeof PublicKeyCredential !== "undefined" &&
      (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    platformOk = false;
  }
  return platformOk;
}

export const faceUnlockEnabled = () => read() !== null;
export const faceOfferDismissed = () => {
  try {
    return localStorage.getItem(DISMISS) === "1";
  } catch {
    return false;
  }
};
export function dismissFaceOffer() {
  try {
    localStorage.setItem(DISMISS, "1");
  } catch {
    /* private window: the offer simply shows again next time */
  }
}

export function resetFaceOffer() {
  try {
    localStorage.removeItem(DISMISS);
  } catch {
    /* nothing to reset */
  }
}

export function disableFaceUnlock() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing saved */
  }
}

async function prfSecret(credId: Uint8Array): Promise<Uint8Array> {
  const got = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: "public-key", id: credId as BufferSource }],
      userVerification: "required",
      timeout: 60000,
      extensions: { prf: { eval: { first: SALT } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const out = (got?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } } | undefined)?.prf
    ?.results?.first;
  if (!out) throw new Error("This phone cannot lock the login behind your face.");
  return new Uint8Array(out);
}

async function aesKey(secret: Uint8Array) {
  const base = await crypto.subtle.importKey("raw", secret as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: SALT as BufferSource, info: new TextEncoder().encode("login") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Turn it on: the phone checks your face once, then the login is saved locked behind it. */
export async function enableFaceUnlock(id: string, password: string): Promise<void> {
  const created = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "Darkwood Node", id: location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: id, displayName: id },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
      timeout: 60000,
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!created) throw new Error("Face unlock was cancelled.");
  const prf = (created.getClientExtensionResults() as { prf?: { enabled?: boolean } }).prf;
  if (!prf?.enabled) throw new Error("This phone cannot lock the login behind your face.");

  const credId = new Uint8Array(created.rawId);
  const key = await aesKey(await prfSecret(credId)); // second check: proves the secret works before saving
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify({ id, password })),
  );
  localStorage.setItem(KEY, JSON.stringify({ cred: b64(credId), iv: b64(iv), data: b64(data) } satisfies Saved));
}

/** The phone checks your face; on yes, returns the saved login. Throws if it fails or is cancelled. */
export async function unlockWithFace(): Promise<{ id: string; password: string }> {
  const saved = read();
  if (!saved) throw new Error("Face unlock is not set up on this phone.");
  const key = await aesKey(await prfSecret(unb64(saved.cred)));
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(saved.iv) as BufferSource }, key, unb64(saved.data) as BufferSource);
    return JSON.parse(new TextDecoder().decode(plain)) as { id: string; password: string };
  } catch {
    throw new Error("Face unlock no longer matches. Log in with your password.");
  }
}

/** Set by the login screen after a password login; the offer sheet takes it once, then it is gone. */
let pending: { id: string; password: string } | null = null;
export const holdLoginForOffer = (id: string, password: string) => (pending = { id, password });
export function takePendingLogin() {
  const p = pending;
  pending = null;
  return p;
}
