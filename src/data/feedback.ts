import { setFeedbackReceipt } from "./notifications";
import {
  type Timestamp,
  type Unsubscribe,
  addDoc,
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { upload } from "@vercel/blob/client";

import { auth, db } from "../firebase";
import type { ChatFile } from "./store";

/*
 * Feedback for the developers (rules: M2A-Access-Control/firestore.rules):
 *
 *   feedback/{fid}   uid, name, username, type "bug"|"idea"|"other", text,
 *                    files [{url,name,type,size}], context {where, page,
 *                    browser, screen}, status "new"|"working"|"done",
 *                    createdAt, reply?, repliedAt?, repliedBy?
 *
 * Any approved member writes one; they read only their own. The owner and
 * admins read all of them and set the status and reply.
 */

export type FeedbackType = "bug" | "idea" | "other";
export type FeedbackStatus = "new" | "working" | "done";
export type FeedbackContext = { where: string; page: string; browser: string; screen: string };

export type Feedback = {
  id: string;
  uid: string;
  name: string;
  username: string;
  type: FeedbackType;
  text: string;
  files: ChatFile[];
  context: FeedbackContext;
  status: FeedbackStatus;
  createdAt: Date | null;
  reply?: string;
  repliedAt: Date | null;
};

const MAX_FEEDBACK_FILE_BYTES = 50 * 1024 * 1024;

function toFeedback(id: string, data: Record<string, unknown>): Feedback {
  const at = (v: unknown) => (v as Timestamp | undefined)?.toDate?.() ?? null;
  return {
    id,
    uid: String(data.uid ?? ""),
    name: String(data.name ?? ""),
    username: String(data.username ?? ""),
    type: (data.type as FeedbackType) ?? "other",
    text: String(data.text ?? ""),
    files: (data.files as ChatFile[] | undefined) ?? [],
    context: (data.context as FeedbackContext | undefined) ?? { where: "", page: "", browser: "", screen: "" },
    status: (data.status as FeedbackStatus) ?? "new",
    createdAt: at(data.createdAt),
    reply: data.reply as string | undefined,
    repliedAt: at(data.repliedAt),
  };
}

/** Where the person is and what they use, added to every feedback by itself. */
export function feedbackContext(where: string): FeedbackContext {
  return {
    where,
    page: location.pathname + location.search.replace(/token=[^&]*/g, "token=…"),
    browser: navigator.userAgent,
    screen: `${screen.width}x${screen.height} (window ${innerWidth}x${innerHeight}, ${devicePixelRatio}x)`,
  };
}

/** A screenshot or file for a feedback (Vercel Blob, feedback/<uid>/). */
export async function uploadFeedbackFile(file: File, onProgress: (percent: number) => void): Promise<ChatFile> {
  if (file.size > MAX_FEEDBACK_FILE_BYTES) throw new Error(`${file.name} is over 50 MB`);
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error("Log in first.");
  const safeName = file.name.replace(/[^\w.-]+/g, "_").slice(-80) || "file";
  const blob = await upload(`feedback/${auth.currentUser!.uid}/${safeName}`, file, {
    access: "public",
    handleUploadUrl: "/api/upload",
    clientPayload: JSON.stringify({ idToken, kind: "feedback" }),
    contentType: file.type || undefined,
    onUploadProgress: ({ percentage }) => onProgress(percentage),
  });
  return { url: blob.url, name: file.name, type: file.type || blob.contentType || "", size: file.size };
}

export async function sendFeedback(input: {
  uid: string;
  name: string;
  username: string;
  type: FeedbackType;
  text: string;
  files: ChatFile[];
  context: FeedbackContext;
}) {
  const result = await addDoc(collection(db, "feedback"), { ...input, status: "new", createdAt: serverTimestamp() });
  setFeedbackReceipt({id:result.id,uid:input.uid,type:input.type,at:Date.now()});
  return result;
}

/** Your own feedback, newest first. */
export function watchMyFeedback(uid: string, cb: (list: Feedback[]) => void, onError?: (err: Error) => void): Unsubscribe {
  return onSnapshot(query(collection(db, "feedback"), where("uid", "==", uid)), (snap) => {
    const list = snap.docs.map((d) => toFeedback(d.id, d.data()));
    list.sort((a, b) => (b.createdAt?.getTime() ?? Infinity) - (a.createdAt?.getTime() ?? Infinity));
    cb(list);
  }, err => onError?.(err));
}

/** Everyone's feedback, newest first (owner and admins only). */
export function watchAllFeedback(cb: (list: Feedback[]) => void, onError?: (err: Error) => void): Unsubscribe {
  return onSnapshot(
    query(collection(db, "feedback"), orderBy("createdAt", "desc"), limit(500)),
    (snap) => cb(snap.docs.map((d) => toFeedback(d.id, d.data()))),
    (err) => onError?.(err),
  );
}

export const setFeedbackStatus = (fid: string, status: FeedbackStatus) =>
  updateDoc(doc(db, "feedback", fid), { status });

export const replyToFeedback = (fid: string, reply: string, by: string) =>
  updateDoc(doc(db, "feedback", fid), { reply, repliedAt: serverTimestamp(), repliedBy: by });
