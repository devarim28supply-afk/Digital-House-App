import { upload } from "@vercel/blob/client";

import { auth } from "../firebase";
import type { ChatFile, ProfilePicture } from "./store";

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

/** The largest banner or profile-card picture (GIFs included). */
const MAX_PICTURE_BYTES = 10 * 1024 * 1024;

/** A still picture, made smaller. A GIF never comes here: it goes up whole. */
async function shrinkStill(file: File, maxWidth: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not read that picture");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) throw new Error("Could not read that picture");
  return blob;
}

/**
 * Put a picture on the server banner or on your profile card. A GIF is
 * uploaded byte for byte, so it keeps moving; a still is shrunk first. The
 * name is the file it lands as, inside the banner or profile folder.
 */
export async function uploadPicture(
  file: File,
  where: { kind: "banner"; serverId: string } | { kind: "profile"; name: ProfilePicture },
): Promise<string> {
  if (!/^image\/(png|gif|webp|jpeg)$/.test(file.type)) throw new Error("Use a PNG, GIF, WebP or JPG picture");
  if (file.size > MAX_PICTURE_BYTES) throw new Error("A picture can be up to 10 MB");
  const gif = file.type === "image/gif";
  const body = gif ? file : await shrinkStill(file, where.kind === "banner" ? 960 : 512);
  if (body.size > MAX_PICTURE_BYTES) throw new Error("That picture is too big");
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error("Log in first.");
  const folder = where.kind === "banner" ? `banner/${where.serverId}/` : `profile/${auth.currentUser!.uid}/`;
  const name = where.kind === "banner" ? "banner" : where.name;
  const blob = await upload(`${folder}${name}.${gif ? "gif" : "jpg"}`, body, {
    access: "public",
    handleUploadUrl: "/api/upload",
    clientPayload: JSON.stringify({ idToken, kind: where.kind, serverId: where.kind === "banner" ? where.serverId : undefined }),
    contentType: gif ? "image/gif" : "image/jpeg",
  });
  return blob.url;
}
