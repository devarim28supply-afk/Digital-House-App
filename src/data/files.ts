import { upload } from "@vercel/blob/client";

import { auth } from "../firebase";
import type { ChatFile } from "./store";

/** The largest file one message can carry (Kaalob: 500 MB). */
export const MAX_FILE_BYTES = 500 * 1024 * 1024;

/**
 * Send a picture, video or file to Vercel Blob for a chat. The browser
 * uploads it directly; api/upload.ts only hands out the pass, after Firestore
 * confirms you are in that server. Big files go up in parts.
 */
export async function uploadChatFile(
  serverId: string,
  channelId: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<ChatFile> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is over 500 MB`);
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error("Log in first.");
  const safeName = file.name.replace(/[^\w.-]+/g, "_").slice(-80) || "file";
  const blob = await upload(`chat/${serverId}/${channelId}/${safeName}`, file, {
    access: "public",
    handleUploadUrl: "/api/upload",
    clientPayload: JSON.stringify({ idToken, serverId, channelId }),
    contentType: file.type || undefined,
    multipart: file.size > 20 * 1024 * 1024,
    onUploadProgress: ({ percentage }) => onProgress(percentage),
  });
  return { url: blob.url, name: file.name, type: file.type || blob.contentType || "", size: file.size };
}

/** The largest server emoji picture (a little GIF included). */
export const MAX_EMOJI_BYTES = 2 * 1024 * 1024;

/** Upload a picture or little GIF as one of the server's emojis. */
export async function uploadEmoji(serverId: string, file: File): Promise<string> {
  if (!/^image\/(png|gif|webp|jpeg)$/.test(file.type)) throw new Error("Use a PNG, GIF, WebP or JPG picture");
  if (file.size > MAX_EMOJI_BYTES) throw new Error("An emoji can be up to 2 MB");
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error("Log in first.");
  const safeName = file.name.replace(/[^\w.-]+/g, "_").slice(-60) || "emoji";
  const blob = await upload(`emoji/${serverId}/${safeName}`, file, {
    access: "public",
    handleUploadUrl: "/api/upload",
    clientPayload: JSON.stringify({ idToken, serverId, kind: "emoji" }),
    contentType: file.type,
  });
  return blob.url;
}
