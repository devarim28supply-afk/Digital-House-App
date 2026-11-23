import { doc, getDoc } from "firebase/firestore";
import { createSignal } from "solid-js";
import { db } from "../firebase";
import { lookupInvite, normalizeInviteCode, redeemInvite } from "./store";

/**
 * Invite links. A link is this site's address with the server's invite code on
 * it. In a chat it shows as a card (the server's banner, icon, name and an
 * Accept button), like Discord (Kaalob). The same in the desktop app
 * (lib/data/invites.dart).
 *
 * A person who is not in the server cannot read its name or banner, so the
 * person who SENDS the link puts them on the message (`invite`); the card is
 * drawn from that. Joining is the same as typing the code: the rules check it.
 */

/** The servers you are in, kept by the shell: a card says "Go to server" for one of them. */
const [joinedServerIds, setJoinedServerIds] = createSignal<ReadonlySet<string>>(new Set());
export { joinedServerIds, setJoinedServerIds };

/** Open this server (now, or as soon as it is in your list). Set by the shell. */
export const inviteDoor: { open?: (serverId: string) => void } = {};

export const inviteLink = (code: string) => `https://darkwood-node.vercel.app/app/?invite=${code}`;

const INVITE_RE = /darkwood-node\.vercel\.app\/app\/?\?invite=([A-Za-z0-9]{8})(?![A-Za-z0-9])/i;

/** The invite code of the first invite link in this text, or undefined. */
export const inviteCodeIn = (text: string) => INVITE_RE.exec(text)?.[1]?.toUpperCase();

/** What a card shows of the server. */
export type InviteInfo = { code: string; serverId: string; name?: string; banner?: string; icon?: string; members?: number };

/** From a message's `invite` field. */
export function inviteInfoFrom(data: unknown): InviteInfo | undefined {
  const d = data as Record<string, unknown> | undefined;
  if (!d || typeof d !== "object" || typeof d.code !== "string") return undefined;
  return {
    code: normalizeInviteCode(d.code),
    serverId: typeof d.serverId === "string" ? d.serverId : "",
    name: typeof d.name === "string" ? d.name : undefined,
    banner: typeof d.banner === "string" ? d.banner : undefined,
    icon: typeof d.icon === "string" ? d.icon : undefined,
    members: typeof d.members === "number" ? d.members : undefined,
  };
}

async function readInvite(code: string): Promise<InviteInfo> {
  const invite = await lookupInvite(code);
  const out: InviteInfo = { code: invite.code, serverId: invite.serverId };
  try {
    // you are in the server: all of it
    const d = (await getDoc(doc(db, "servers", invite.serverId))).data() ?? {};
    if (typeof d.name === "string") out.name = d.name;
    if (typeof d.banner === "string" && d.banner.startsWith("http")) out.banner = d.banner;
    if (typeof d.icon === "string" && d.icon.startsWith("http")) out.icon = d.icon;
    if (Array.isArray(d.memberUids)) out.members = d.memberUids.length;
  } catch {
    // you are not in it: its name, when it is listed in Find a server
    const d = (await getDoc(doc(db, "serverDirectory", invite.serverId))).data();
    if (typeof d?.name === "string") out.name = d.name;
  }
  return out;
}

/**
 * For a message about to be sent: when it has an invite link, the server's
 * name, banner and icon to put on it. Undefined when it has no link, the code
 * is not a server's, or it takes too long (the card then shows without them).
 */
export async function inviteFieldFor(text: string): Promise<InviteInfo | undefined> {
  const code = inviteCodeIn(text);
  if (!code) return undefined;
  try {
    return await Promise.race([
      readInvite(code),
      new Promise<undefined>((done) => setTimeout(() => done(undefined), 4000)),
    ]);
  } catch {
    return undefined;
  }
}

/** Accept an invite: join the server its code is for. Returns the server's id. */
export async function acceptInvite(uid: string, code: string) {
  const invite = await lookupInvite(code);
  if (!joinedServerIds().has(invite.serverId)) await redeemInvite(uid, invite.serverId, invite.code);
  return invite.serverId;
}
