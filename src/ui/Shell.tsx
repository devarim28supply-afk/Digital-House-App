
import { Notifications, NotificationList, type Notice } from "./Notifications";
import { SelfControls } from "./SelfControls";
import { availabilityStatus, availabilityLabel } from "../data/status";
import { DeveloperBadge } from "./DeveloperBadge";
import { Customize } from "./Customize";
import { customization, nameplateClass, PATRICK_GIF } from "../data/customization";
import { For, type JSX, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";

import {
  type Channel,
  type Emoji,
  ONLINE_WINDOW_MS,
  type Presence,
  type Profile,
  type Server,
  addServerMembers,
  createChannel,
  createRoomTile,
  createServer,
  deleteRoomTile,
  ensureHomeServer,
  ensureHomeTiles,
  joinOpenServers,
  setServerOpen,
  imageSrc,
  isBuiltInTile,
  removeServerMember,
  saveServerSettings,
  deleteServer,
  saveProfile,
  shrinkImage,
  startPresence,
  watchChannels,
  displayName,
  setTileImage,
  watchEmojis,
  watchPresence,
  watchProfiles,
  watchServers,
  hasDarkwoodRoom,
} from "../data/store";
import { uploadPicture } from "../data/files";
import { ActivityButton } from "./ActivityPanel";
import { Chat } from "./Chat";
import { DM_CALL, DM_CHAT, dmPartner, isDm, markRead, openDm, readTimes, watchLatest } from "../data/dms";
import { FeedbackDialog } from "./Feedback";
import { Modal } from "./Modal";
import { RoomPane } from "./RoomPane";
import { VoiceRoom } from "./VoiceRoom";
import { setWatchRequest, streamingIn, whereNow } from "../data/where";
import { LiveTile } from "./LiveTile";
import { SideTv } from "./SideTv";

import "./app.css";

const LAST_SERVER_KEY = "dh_last_server";
const lastChannelKey = (sid: string) => `dh_last_channel_${sid}`;
const RIGHT_MODE_KEY = "dh_right_mode";
const LEFT_MODE_KEY = "dh_left_mode";
type SidebarMode = "slide" | "pinned" | "hover";
// a tile shows up to this many faces, then "+N"
const TILE_FACES = 5;
// other names a tile's room goes by in people's "where"
const TILE_ALIASES: Record<string, string[]> = { "m2a-operation": ["M2A-access"] };
// how long a new chat message keeps the right sidebar slid in
const RIGHT_HOLD_MS = 30_000;
// how long it stays after the mouse leaves it
const RIGHT_LINGER_MS = 5_000;

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}
function recall(key: string) {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
}

/** A round picture: their profile picture if they have one, else their colour. */
export function faceStyle(profile: Profile | undefined, fallback = "#404040"): JSX.CSSProperties {
  const color = profile?.color ?? fallback;
  const decoration = customization(profile?.customization).decoration;
  return {
    "background-color": decoration === "patrick" ? "transparent" : color,
    "background-image": decoration !== "patrick" && profile?.photo ? `url("${profile.photo}")` : "none",
    "background-size": "cover", "background-position": "center",
    "border-color": decoration === "patrick" ? "transparent" : undefined,
    "--avatar-inner-display": decoration === "patrick" ? "block" : "none",
    "--avatar-inner-image": profile?.photo ? `url("${profile.photo}")` : "none",
    "--avatar-inner-color": color,
    "--avatar-decoration": decoration === "patrick" ? `url("${PATRICK_GIF}")` : "none",
    "--profile-avatar-border-width": decoration === "neon" ? "2px" : undefined,
    "--avatar-decoration-radius": decoration === "patrick" ? "0" : "50%",
    "--avatar-ring": decoration === "orbit" ? "2px dotted #dddffb" : decoration === "neon" ? "2px solid #9d74ff" : "0px solid transparent",
    "--avatar-glow": decoration === "neon" ? "0 0 13px #9d74ff" : "none",
  } as JSX.CSSProperties;
}
/** The initials inside it, only when there is no picture. */
export const faceText = (profile: Profile | undefined, name: string) => (profile?.photo ? "" : initials(name));
/** The card's top strip or its background: the chosen picture over your colour. */
function pictureStyle(profile: Profile | undefined, field: "banner" | "background"): JSX.CSSProperties {
  const url = profile?.[field];
  const color = field === "banner" ? customization(profile?.customization).bannerColor : profile?.color ?? "#404040";
  return url
    ? { "background-color": color, "background-image": `url("${url}")`, "background-size": "cover", "background-position": "center" }
    : { background: color };
}

/**
 * Darkwood Node once you are in: servers on the far left, the chosen
 * server's channels next to them, the channel in the middle, and who is in
 * the server on the right. On a phone the two left columns slide in.
 */
export function Shell(props: { uid: string; admin: boolean; developer?: boolean; name: string; username: string; onLogout: () => void }) {
  const [servers, setServers] = createSignal<Server[]>([]);
  const [profiles, setProfiles] = createSignal(new Map<string, Profile>());
  const [presence, setPresence] = createSignal(new Map<string, Presence>());
  const [now, setNow] = createSignal(Date.now());
  const [serverId, setServerId] = createSignal<string | undefined>(recall(LAST_SERVER_KEY));
  const [channels, setChannels] = createSignal<Channel[]>([]);
  const [channelId, setChannelId] = createSignal<string | undefined>();
  const [customizeOpen, setCustomizeOpen] = createSignal(false);
  const [navOpen, setNavOpen] = createSignal(false);
  const [sideChatOpen, setSideChatOpen] = createSignal(false);
  const [mobilePanel, setMobilePanel] = createSignal<"chat" | "people">("chat");
  let callSwipe: {x:number;y:number;at:number} | undefined;
  let panelSwipe: {x:number;y:number;at:number;panel:"chat"|"channels"} | undefined;
  let panelSwipeClickBlockedUntil=0;
  function startPanelSwipe(event:TouchEvent) {
    const target=event.target instanceof Element ? event.target : undefined;
    const panel=target?.closest(".side-chat") ? "chat" : target?.closest(".side,.rail") ? "channels" : undefined;
    if(!window.matchMedia("(max-width:600px)").matches || !panel || event.touches.length !== 1 || target?.closest("input,textarea,video,audio,[role=slider],.mobile-panel-switch,.message-actions-menu,.inset-resize") || panel === "chat" && Boolean(target?.closest("a,button"))) {panelSwipe=undefined;return;}
    const touch=event.touches[0];panelSwipe={x:touch.clientX,y:touch.clientY,at:Date.now(),panel};
  }
  function movePanelSwipe(event:TouchEvent) {
    if(!panelSwipe || event.touches.length !== 1) {panelSwipe=undefined;return;}
    const touch=event.touches[0],dx=touch.clientX-panelSwipe.x,dy=touch.clientY-panelSwipe.y;
    if(Math.abs(dy)>20 && Math.abs(dy)>Math.abs(dx)) {panelSwipe=undefined;return;}
    const back=panelSwipe.panel === "chat" ? dx>14 : dx< -14;
    if(back && Math.abs(dx)>Math.abs(dy)*1.4 && event.cancelable) event.preventDefault();
  }
  function endPanelSwipe(event:TouchEvent) {
    const start=panelSwipe;panelSwipe=undefined;
    if(!start || !event.changedTouches.length || Date.now()-start.at>1000) return;
    const touch=event.changedTouches[0],dx=touch.clientX-start.x,dy=touch.clientY-start.y;
    if(Math.abs(dx)<60 || Math.abs(dx)<Math.abs(dy)*1.5) return;
    const returning = start.panel === "chat" ? dx>0 : dx<0;
    if(returning) {panelSwipeClickBlockedUntil=Date.now()+300;if(event.cancelable) event.preventDefault();}
    if(start.panel === "chat" && dx>0) {setSideChatOpen(false);setEdgeHover(false);setChatPing(false);
      if(document.activeElement instanceof HTMLElement && document.activeElement.closest(".side-chat")) document.activeElement.blur();}
    else if(start.panel === "channels" && dx<0) {setNavOpen(false);setLeftHover(false);}
  }
  function startCallSwipe(event:TouchEvent) {
    const target=event.target instanceof Element ? event.target : undefined;
    if(!window.matchMedia("(max-width:600px)").matches || event.touches.length !== 1 || !target?.closest(".voice,.room-pane") || target.closest("button,input,textarea,a,[role=slider],.dock-menu,.inset-resize,video[controls]")) {callSwipe=undefined;return;}
    const touch=event.touches[0];callSwipe={x:touch.clientX,y:touch.clientY,at:Date.now()};
  }
  function moveCallSwipe(event:TouchEvent) {
    if(!callSwipe || event.touches.length !== 1) {callSwipe=undefined;return;}
    const touch=event.touches[0],dx=touch.clientX-callSwipe.x,dy=touch.clientY-callSwipe.y;
    if(Math.abs(dy)>20 && Math.abs(dy)>Math.abs(dx)) {callSwipe=undefined;return;}
    if(Math.abs(dx)>14 && Math.abs(dx)>Math.abs(dy)*1.4 && event.cancelable) event.preventDefault();
  }
  function endCallSwipe(event:TouchEvent) {
    const start=callSwipe;callSwipe=undefined;
    if(!start || !event.changedTouches.length || Date.now()-start.at>1000) return;
    const touch=event.changedTouches[0],dx=touch.clientX-start.x,dy=touch.clientY-start.y;
    if(Math.abs(dx)<60 || Math.abs(dx)<Math.abs(dy)*1.5) return;
    if(dx<0 && tileChat()) {setMobilePanel("chat");setNavOpen(false);setSideChatOpen(true);}
    else if(dx>0) {setSideChatOpen(false);setNavOpen(true);}
  }
  const [modal, setModal] = createSignal<"" | "new-server" | "rename" | "people" | "new-channel" | "me">("");
  // Feedback for the developers: from the top bar, or the Darkwood Room's
  // own button (it asks this page to open it), or /app/?feedback
  const [feedbackOpen, setFeedbackOpen] = createSignal(new URLSearchParams(location.search).has("feedback"));
  const [notificationItems, setNotificationItems] = createSignal<Notice[]>([]);
  const [notificationError, setNotificationError] = createSignal("");
  const [feedbackTab, setFeedbackTab] = createSignal<"send" | "mine" | "inbox">("send", { equals: false });
  const [feedbackWhere, setFeedbackWhere] = createSignal("");
  function openFeedback(where = "") {
    setFeedbackTab("send");
    setFeedbackWhere(where);
    setFeedbackOpen(true);
  }
  const onRoomMessage = (e: MessageEvent) => {
    if (e.origin === location.origin && e.data?.type === "dh-feedback") openFeedback(String(e.data.where ?? "Darkwood Room"));
  };
  window.addEventListener("message", onRoomMessage);
  onCleanup(() => window.removeEventListener("message", onRoomMessage));
  // Your one videochat, like Discord voice: opening a room tile or voice
  // channel joins it, and it stays connected while you read other channels
  // (or servers) until Disconnect. Joining another one moves you there.
  const [call, setCall] = createSignal<{ serverId: string; channel: Channel } | undefined>();
  function joinCall(serverId: string, ch: Channel) {
    // the same channel id can be in two places (every DM's call is "call")
    if (call()?.serverId === serverId && call()?.channel.id === ch.id) return;
    setCall({ serverId, channel: ch });
  }
  function goToCall() {
    const c = call();
    if (!c) return;
    remember(lastChannelKey(c.serverId), c.channel.id);
    if (serverId() === c.serverId) setChannelId(c.channel.id);
    else setServerId(c.serverId);
    setNavOpen(false);
  }

  onMount(() => {
    void saveProfile(props.uid, props.name, props.username);
    // Open Digital House first, then join every open server.
    void (async () => {
      if (props.admin) await ensureHomeServer(props.uid).catch(() => {});
      await joinOpenServers(props.uid).catch(() => {});
    })();
    const me = startPresence(props.uid);
    // tell everyone where you are: a call or a room's Room view
    createEffect(() => me.setWhere(whereNow()));
    // stream mode on: everyone in that server gets a LIVE tile
    createEffect(() => me.setStreaming(streamingIn() ?? null));
    const stops = [
      me.stop,
      watchServers(props.uid, setServers),
      watchProfiles(setProfiles),
      watchPresence(setPresence),
    ];
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    onCleanup(() => {
      stops.forEach((stop) => stop());
      window.clearInterval(tick);
    });
  });

  // ---- direct messages (data/dms.ts): a DM is a tiny private server for two.
  // The ✉ button at the top of the server rail shows your DMs in the left
  // column; servers keep their own buttons below it.
  const realServers = createMemo(() => servers().filter((x) => !isDm(x)));
  const dms = createMemo(() => servers().filter(isDm));
  const [dmHome, setDmHome] = createSignal(false);
  const [newDm, setNewDm] = createSignal(false);
  // the newest message in each DM, and when you last read each one here
  const [latest, setLatest] = createSignal(new Map<string, { at: number; author: string }>());
  const [readAt, setReadAt] = createSignal(readTimes());
  createEffect(
    on(
      () => dms().map((d) => d.id).join(","),
      (ids) => {
        const stops = ids
          .split(",")
          .filter(Boolean)
          .map((id) =>
            watchLatest(id, (l) =>
              setLatest((prev) => {
                const next = new Map(prev);
                if (l) next.set(id, l);
                else next.delete(id);
                return next;
              }),
            ),
          );
        onCleanup(() => stops.forEach((stop) => stop()));
      },
    ),
  );
  const dmUnread = (id: string) => {
    const l = latest().get(id);
    return Boolean(l && l.author !== props.uid && l.at > (readAt()[id] ?? 0));
  };
  const unreadDms = () => dms().filter((d) => dmUnread(d.id)).length;
  // newest conversation first
  const dmsByLatest = () =>
    [...dms()].sort((a, b) => (latest().get(b.id)?.at ?? 0) - (latest().get(a.id)?.at ?? 0));
  async function startDm(uid: string) {
    setCard(undefined);
    setNewDm(false);
    try {
      const id = await openDm(props.uid, uid, servers());
      setDmHome(true);
      setServerId(id);
      setNavOpen(false);
    } catch {
      /* the other person started it at the same moment: it shows up shortly */
    }
  }
  function openServer(id: string) {
    setDmHome(false);
    setServerId(id);
  }
  function goDms() {
    setDmHome(true);
    const first = dmsByLatest()[0];
    if (first && !isDm(server())) setServerId(first.id);
  }

  // Keep a valid server picked.
  createEffect(() => {
    const list = servers();
    if (!list.length) return;
    if (!list.some((s) => s.id === serverId())) setServerId((realServers()[0] ?? list[0]).id);
  });

  const server = createMemo(() => servers().find((s) => s.id === serverId()));
  // in a DM nobody runs anything: no settings, tiles or people to add
  const runsServer = () => Boolean(server() && !isDm(server()) && (server()!.ownerUid === props.uid || props.admin));
  // the left column shows your DMs (the ✉ button, or a DM is open)
  const dmMode = () => dmHome() || isDm(server());
  const dmName = (d: { memberUids: string[]; ownerUid: string }) => nameOf(dmPartner(d as never, props.uid));

  // Channels of the picked server, and a valid channel in it.
  createEffect(() => {
    const sid = serverId();
    setChannels([]);
    setChannelId(undefined);
    if (!sid) return;
    remember(LAST_SERVER_KEY, sid);
    let tileChecked = false;
    const stop = watchChannels(sid, (list) => {
      setChannels(list);
      // The home server's built-in tiles, added once for servers made before
      // them. The home server is the one with the Living Room tile (its name
      // can be changed), or a "Digital House" without tiles yet.
      const s = servers().find((x) => x.id === sid);
      const isHome =
        list.some((c) => c.kind === "room" && c.roomKey === "gestr-living") || s?.name.startsWith("Digital House");
      if (!tileChecked && isHome && s?.ownerUid === props.uid) {
        tileChecked = true;
        void ensureHomeTiles(sid, list).catch(() => {});
        // The lock wrote open:false. Digital House is open again.
        if (s.open !== true) void setServerOpen(sid, true).catch(() => {});
      }
      const current = channelId();
      if (current && list.some((c) => c.id === current)) return;
      const saved = recall(lastChannelKey(sid));
      // only picture tiles are shown (Kaalob): reopen the last tile, else the first
      const pick = list.find((c) => c.id === saved && c.kind === "room") ?? list.find((c) => c.kind === "room") ?? list[0];
      setChannelId(pick?.id);
    });
    onCleanup(stop);
  });

  const channel = createMemo(() => channels().find((c) => c.id === channelId()));
  createEffect(() => {
    const sid = serverId();
    if (!sid || !isDm(server()) || channelId() !== DM_CHAT) return;
    const l = latest().get(sid);
    markRead(sid, l?.at ?? Date.now());
    setReadAt(readTimes());
  });

  // The picked server's own emojis, for every chat in it.
  const [emojis, setEmojis] = createSignal<Emoji[]>([]);
  createEffect(() => {
    const sid = serverId();
    setEmojis([]);
    if (!sid) return;
    onCleanup(watchEmojis(sid, setEmojis));
  });

  function pickChannel(id: string) {
    setChannelId(id);
    const sid = serverId();
    if (sid) remember(lastChannelKey(sid), id);
    setNavOpen(false);
    // clicking a room tile or voice channel puts you in its videochat
    const ch = channels().find((c) => c.id === id);
    if (sid && ch && (ch.kind === "room" || ch.kind === "voice")) joinCall(sid, ch);
  }
  const inThisCall = () => Boolean(channel() && call()?.serverId === serverId() && call()?.channel.id === channel()!.id);

  // The right sidebar slides out of the way. A new chat message slides it in
  // for 30 seconds (each message restarts the 30); the cursor at the right
  // edge of the screen slides it in while it is there.
  const [edgeHover, setEdgeHover] = createSignal(false);
  // Leaving it, it stays 5 more seconds (Kaalob); coming back cancels that.
  let leaveTimer = 0;
  function enterRight() {
    window.clearTimeout(leaveTimer);
    leaveTimer = 0;
    setEdgeHover(true);
  }
  function leaveRight() {
    if (leaveTimer) return;
    leaveTimer = window.setTimeout(() => { leaveTimer = 0; setEdgeHover(false); }, rightMode() === "hover" ? 100 : RIGHT_LINGER_MS);
  }
  onCleanup(() => window.clearTimeout(leaveTimer));
  const [chatPing, setChatPing] = createSignal(false);
  let pingTimer = 0;
  // phones and tablets: no slide-in over the call, a red dot on the chat button
  const [unread, setUnread] = createSignal(false);
  const TOUCH = matchMedia("(hover: none)").matches;
  createEffect(() => {
    if (sideChatOpen()) setUnread(false);
  });
  function pingRight() {
    if (availabilityStatus(profiles().get(props.uid)?.availability) === "dnd") { setUnread(true); return; }
    if (TOUCH) {
      if (!sideChatOpen()) setUnread(true);
      return;
    }
    setChatPing(true);
    window.clearTimeout(pingTimer);
    pingTimer = window.setTimeout(() => setChatPing(false), RIGHT_HOLD_MS);
  }
  onCleanup(() => window.clearTimeout(pingTimer));

  // A person's profile card, like Discord's, next to where you clicked.
  const [card, setCard] = createSignal<{ uid: string; x: number; y: number; anchorRight: number; keepLeftOpen: boolean; keepRightOpen: boolean } | undefined>();
  const openCard = (uid: string, at: MouseEvent) => {
    const target = at.currentTarget instanceof Element ? at.currentTarget : undefined;
    const row = target?.closest(".member, .me, .msg-head") ?? target;
    const bounds = row?.getBoundingClientRect();
    // Right-hand member cards emerge from the sidebar edge, without covering its names.
    const edge = target?.closest(".members")?.getBoundingClientRect() ?? bounds;
    setCard({
      uid, x: edge?.left ?? at.clientX, anchorRight: edge?.right ?? at.clientX, y: bounds?.top ?? at.clientY,
      // Preserve the panels visible at the click, including the source panel.
      keepLeftOpen: leftHover() || Boolean(target?.closest(".rail, .side")) || Boolean(card()?.keepLeftOpen),
      keepRightOpen: edgeHover() || sideChatOpen() || chatPing() || Boolean(target?.closest(".members, .side-chat")) || Boolean(card()?.keepRightOpen),
    });
  };
  // A profile card opened from the sidebar keeps the sidebar in until it closes.
  // A file dragged in from a folder slides it in too, so it can be dropped on the chat.
  const [fileDrag, setFileDrag] = createSignal(false);
  const rightOpen = () => rightMode() === "hover" && !TOUCH
    ? edgeHover() || Boolean(card()?.keepRightOpen)
    : edgeHover() || chatPing() || sideChatOpen() || Boolean(card()?.keepRightOpen) || fileDrag();

  // The left side (servers + room tiles) slides out of the way while you are
  // in your videochat or room, to give it the room (Kaalob). The cursor at
  // the left edge brings it in; it stays 5 s after the mouse leaves; the pin
  // keeps it always showing. Outside a call it stays as it is.
  const savedLeftMode = recall("dh_sidebar_mode") ?? recall(RIGHT_MODE_KEY) ?? recall(LEFT_MODE_KEY);
  const [leftMode, setLeftMode] = createSignal<SidebarMode>(savedLeftMode === "pinned" || savedLeftMode === "hover" ? savedLeftMode : "slide");
  const leftPinned = () => leftMode() === "pinned";
  function chooseLeftMode(mode: SidebarMode) {
    window.clearTimeout(leftTimer); leftTimer = 0;
    setLeftMode(mode); setLeftHover(false);
    remember(LEFT_MODE_KEY, mode);
  }
  const pinLeft = (on: boolean) => chooseSidebarMode(on ? "pinned" : "slide");
  const [leftHover, setLeftHover] = createSignal(false);
  let leftTimer = 0;
  function enterLeft() {
    window.clearTimeout(leftTimer);
    leftTimer = 0;
    setLeftHover(true);
  }
  function leaveLeft() {
    if (leftTimer) return;
    leftTimer = window.setTimeout(() => { leftTimer = 0; setLeftHover(false); }, leftMode() === "hover" ? 100 : RIGHT_LINGER_MS);
  }
  onCleanup(() => window.clearTimeout(leftTimer));
  const leftSlides = () => !leftPinned() && (inThisCall() || leftMode() === "hover" && !TOUCH);
  // Each person picks: the sidebar slides in and out, or it is always there
  // as its own column beside the videochat (covering nothing). Remembered.
  const savedRightMode = savedLeftMode;
  const [rightMode, setRightMode] = createSignal<SidebarMode>(savedRightMode === "pinned" || savedRightMode === "hover" ? savedRightMode : "slide");
  const rightPinned = () => rightMode() === "pinned";
  function chooseRightMode(mode: SidebarMode) {
    window.clearTimeout(leaveTimer); leaveTimer = 0; window.clearTimeout(pingTimer);
    setRightMode(mode); setEdgeHover(false); setChatPing(false); setSideChatOpen(false);
    remember(RIGHT_MODE_KEY, mode);
  }
  function chooseSidebarMode(mode: SidebarMode) {
    chooseLeftMode(mode);
    chooseRightMode(mode);
    remember("dh_sidebar_mode", mode);
  }
  const pinRight = (on: boolean) => chooseSidebarMode(on ? "pinned" : "slide");

  const isOnline = (uid: string) => availabilityStatus(profiles().get(uid)?.availability) !== "invisible" && now() - (presence().get(uid)?.lastSeen ?? 0) < ONLINE_WINDOW_MS;
  // where an online person is; a place older than the window has expired
  const whereOf = (uid: string) => {
    if (availabilityStatus(profiles().get(uid)?.availability) === "invisible") return "";
    const p = presence().get(uid);
    return p?.where && now() - p.whereAt < ONLINE_WINDOW_MS ? p.where : "";
  };
  const onlineHere = () => server()?.memberUids.filter(isOnline) ?? [];
  // Who is streaming in this server right now (stream mode): their LIVE tiles.
  // Kept as plain text keys ("uid|channel"): a key stays the same string while
  // the stream goes on, so its LIVE tile stays put. Rebuilt objects would make
  // the list throw the tile away (and reconnect it) on every presence beat.
  // A team (streamers who teamed up, in the same videochat) is one key:
  // "uid1,uid2|channel", members sorted, so it stays the same string.
  const liveStreams = createMemo(
    () => {
      const live = new Map<string, string>(); // uid -> channel
      const teamOf = new Map<string, string | undefined>();
      for (const uid of onlineHere()) {
        const s = presence().get(uid)?.streaming;
        if (!s || s.serverId !== serverId() || !channels().some((c) => c.id === s.channelId)) continue;
        live.set(uid, s.channelId);
        teamOf.set(uid, s.team);
      }
      // join teammates (a points at b, both live in the same videochat)
      const root = new Map<string, string>([...live.keys()].map((u) => [u, u]));
      const find = (u: string): string => (root.get(u) === u ? u : find(root.get(u)!));
      for (const [uid, mate] of teamOf) {
        if (mate && live.get(mate) === live.get(uid)) root.set(find(uid), find(mate));
      }
      const groups = new Map<string, string[]>();
      for (const uid of live.keys()) groups.set(find(uid), [...(groups.get(find(uid)) ?? []), uid]);
      return [...groups.values()].map((members) => `${members.sort().join(",")}|${live.get(members[0])}`).sort();
    },
    [],
    { equals: (a, b) => a.length === b.length && a.every((k, i) => k === b[i]) },
  );
  // The teams streaming in a videochat (2+ teamed-up streamers each): the
  // call shows each team as one rotating screen.
  const teamsIn = (sid: string, cid: string) =>
    sid !== serverId()
      ? []
      : liveStreams()
          .map((key) => key.split("|"))
          .filter(([members, channelId]) => channelId === cid && members.includes(","))
          .map(([members]) => members.split(","));
  /** A LIVE tile: into that videochat, their stream big. */
  function watchStream(uid: string, ch: Channel) {
    setWatchRequest(uid);
    pickChannel(ch.id);
  }
  // Who is in a tile's room right now: standing in the 3D room or in its
  // videochat (their "where"). The bunker's lobby is the Operation Room's room.
  const peopleIn = (tile: Channel) => {
    const names = [tile.name, ...(TILE_ALIASES[tile.roomKey ?? ""] ?? [])];
    const places = new Set(names.flatMap((n) => [`In ${n}`, `Videochat · ${n}`]));
    return onlineHere().filter((uid) => places.has(whereOf(uid)));
  };
  const nameOf = (uid: string) => displayName(profiles().get(uid), uid === props.uid ? props.name : "Member");

  // Picture tiles all the way (Kaalob): # text and voice channels are no
  // longer listed (their data stays). A tile's chat lives in the right sidebar.
  const roomTiles = () => channels().filter((c) => c.kind === "room");
  const chatsOf = (tileId: string) => channels().filter((c) => c.kind === "text" && c.parentId === tileId);
  // With a tile open, its chat sits in the right sidebar.
  const tileChat = createMemo(() => {
    const ch = channel();
    return ch?.kind === "room" ? chatsOf(ch.id)[0] : undefined;
  });

  return (
    <div
      class="shell"
      on:click={(event:MouseEvent) => {if(Date.now()<panelSwipeClickBlockedUntil){event.preventDefault();event.stopPropagation();}}}
      onTouchStart={startPanelSwipe} on:touchmove={movePanelSwipe} onTouchEnd={endPanelSwipe} onTouchCancel={() => {panelSwipe=undefined;}}
      onMouseMove={e => {
        if (TOUCH) return;
        const target = e.target instanceof Element ? e.target : undefined;
        // Coordinate-based activation preserves the wide hover zones without
        // placing an invisible click target above Activity or other controls.
        // Both edges open only in the middle 28–80% height band.
        // Once open, the entire panel remains hoverable.
        const inOpeningBand = e.clientY >= window.innerHeight * 0.28 && e.clientY <= window.innerHeight * 0.80;
        if (leftSlides() && (e.clientX <= 144 && inOpeningBand || leftHover() && target?.closest(".rail, .side"))) enterLeft();
        else if (leftHover()) leaveLeft();
        if (!rightPinned() && (e.clientX >= window.innerWidth - 144 && inOpeningBand || edgeHover() && target?.closest(".side-chat, .members"))) enterRight();
        else if (edgeHover()) leaveRight();
      }}
      onMouseLeave={() => { leaveLeft(); leaveRight(); }}
      classList={{ "nav-open": navOpen(), "with-side-chat": Boolean(tileChat()), "side-chat-open": sideChatOpen(), "right-open": rightOpen(), "right-pinned": rightPinned(), "right-hover-only": rightMode() === "hover" && !TOUCH, "left-slide": leftSlides(), "left-open": leftSlides() && (leftHover() || Boolean(card()?.keepLeftOpen)) }}
    >
      {/* ---- servers ---- */}
      {/* in a call: the strip at the left edge brings the left side in */}
      <Show when={leftSlides()}>
        <div class="left-edge" aria-hidden="true" onMouseEnter={e => { if (leftHover() || e.clientY >= window.innerHeight * 0.28 && e.clientY <= window.innerHeight * 0.80) enterLeft(); }} onMouseLeave={leaveLeft} />
      </Show>
      <nav class="rail" aria-label="Servers" onMouseEnter={e => { if (leftHover() || e.clientY >= window.innerHeight * 0.28 && e.clientY <= window.innerHeight * 0.80) enterLeft(); }} onMouseLeave={leaveLeft}>
        <button
          type="button"
          class="rail-server rail-dm"
          classList={{ active: dmMode() }}
          title="Direct messages"
          aria-label="Direct messages"
          onClick={goDms}
        >
          ✉
          <Show when={unreadDms()}>
            <span class="rail-badge">{unreadDms()}</span>
          </Show>
        </button>
        <For each={realServers()}>
          {(s) => (
            <button
              type="button"
              class="rail-server"
              classList={{ active: !dmMode() && s.id === serverId() }}
              title={s.name}
              aria-label={s.name}
              aria-current={!dmMode() && s.id === serverId() ? "true" : undefined}
              onClick={() => openServer(s.id)}
            >
              {initials(s.name)}
            </button>
          )}
        </For>
        <button type="button" class="rail-add" title="New server" aria-label="New server" onClick={() => setModal("new-server")}>
          +
        </button>
      </nav>

      {/* ---- channels ---- */}
      <aside class="side" onMouseEnter={e => { if (leftHover() || e.clientY >= window.innerHeight * 0.28 && e.clientY <= window.innerHeight * 0.80) enterLeft(); }} onMouseLeave={leaveLeft}>
        {/* the banner on its own, the name in the row under it */}
        <Show when={!dmMode() && server()?.banner}>
          {(banner) => <img class="side-banner" src={banner()} alt="" draggable={false} />}
        </Show>
        <header class="side-head">
          <span class="side-title">{dmMode() ? "Direct messages" : server()?.name ?? "Darkwood Node"}</span>
          <Show when={dmMode()}>
            <button class="icon-btn" type="button" title="New message" aria-label="New message" onClick={() => setNewDm(true)}>
              +
            </button>
          </Show>
          {/* in a call: keep the left side showing, or let it slide away */}
          <Show when={inThisCall()}>
            <PinButton pinned={leftPinned()} onPin={pinLeft} />
          </Show>
          <Show when={runsServer()}>
            <button
              class="icon-btn"
              type="button"
              title="Server settings"
              aria-label="Server settings"
              onClick={() => setModal("rename")}
            >
              ⚙
            </button>
          </Show>
        </header>

        <div class="side-scroll">
          <Show when={dmMode()}>
            <Show when={dms().length} fallback={<p class="side-empty">No messages yet. Start one with +, or from someone's profile card.</p>}>
              <For each={dmsByLatest()}>
                {(d) => {
                  const other = () => dmPartner(d, props.uid);
                  return (
                    <button
                      type="button"
                      class="member dm-row"
                      classList={{ active: d.id === serverId(), unread: dmUnread(d.id) }}
                      onClick={() => {
                        setDmHome(true);
                        setServerId(d.id);
                        setNavOpen(false);
                      }}
                    >
                      <span class="avatar small" style={faceStyle(profiles().get(other()))}>
                        {faceText(profiles().get(other()), nameOf(other()))}
                        <Show when={isOnline(other())}>
                          <i class="dot" />
                        </Show>
                      </span>
                      <span class="member-text">
                        <span class="member-name">{nameOf(other())}<DeveloperBadge username={profiles().get(other())?.username} /></span>
                      </span>
                      <Show when={dmUnread(d.id)}>
                        <i class="dm-dot" aria-label="unread" />
                      </Show>
                    </button>
                  );
                }}
              </For>
            </Show>
          </Show>
          <Show when={!dmMode()}>
          <Show when={server()} fallback={<p class="side-empty">No servers yet. Make one with +, or wait to be added.</p>}>
            {/* someone in stream mode: their LIVE tile first (Kaalob's drawing) */}
            <For each={liveStreams()}>
              {(key) => {
                const [members, channelId] = key.split("|");
                const uids = members.split(",");
                return (
                  <div class="tile-row">
                    <LiveTile
                      serverId={serverId()!}
                      channelId={channelId}
                      uids={uids}
                      nameOf={nameOf}
                      usernameOf={uid => profiles().get(uid)?.username}
                      profileOf={(uid) => profiles().get(uid)}
                      frozen={call()?.serverId === serverId() && call()?.channel.id === channelId}
                      onOpen={(uid) => {
                        const ch = channels().find((c) => c.id === channelId);
                        if (ch) watchStream(uid, ch);
                      }}
                    />
                  </div>
                );
              }}
            </For>
            <For each={roomTiles()}>
              {(c) => (
                <div class="tile-row" classList={{ active: c.id === channelId() }}>
                  <button
                    type="button"
                    class="room-tile"
                    title={c.name}
                    aria-label={`${c.name}: video chat and room`}
                    aria-current={c.id === channelId() ? "true" : undefined}
                    onClick={() => pickChannel(c.id)}
                  >
                    <img src={imageSrc(c.image)} alt="" draggable={false} />
                    <span class="room-tile-name">{c.name}</span>
                    {/* round pictures of who is in this room, like Discord's voice list */}
                    <Show when={peopleIn(c).length}>
                      <span class="tile-people" title={peopleIn(c).map(nameOf).join(", ")}>
                        <For each={peopleIn(c).slice(0, TILE_FACES)}>
                          {(uid) => (
                            <span class="avatar tile-face" style={faceStyle(profiles().get(uid))}>
                              {faceText(profiles().get(uid), nameOf(uid))}
                            </span>
                          )}
                        </For>
                        <Show when={peopleIn(c).length > TILE_FACES}>
                          <span class="avatar tile-face more">+{peopleIn(c).length - TILE_FACES}</span>
                        </Show>
                      </span>
                    </Show>
                  </button>
                  {/* whoever runs the server can change any tile's picture */}
                  <Show when={runsServer()}>
                    <label class="icon-btn tile-pic" title={`Change the picture of ${c.name}`}>
                      🖼
                      <input
                        type="file"
                        accept="image/*"
                        hidden
                        onChange={async (e) => {
                          const file = e.currentTarget.files?.[0];
                          e.currentTarget.value = "";
                          if (!file) return;
                          try {
                            await setTileImage(serverId()!, c.id, await shrinkImage(file, 480), c.name);
                          } catch {
                            /* the old picture stays */
                          }
                        }}
                      />
                    </label>
                  </Show>
                  {/* built-in tiles (Operation Room, Living Room) cannot be deleted */}
                  <Show when={runsServer() && !isBuiltInTile(c)}>
                    <button
                      class="icon-btn tile-del"
                      type="button"
                      title={`Delete ${c.name}`}
                      aria-label={`Delete ${c.name}`}
                      onClick={() => void deleteRoomTile(serverId()!, c.id, channels())}
                    >
                      ✕
                    </button>
                  </Show>
                </div>
              )}
            </For>
            <Show when={runsServer()}>
              <div class="side-tools">
                <button class="side-tool" type="button" onClick={() => setModal("new-channel")}>
                  + Channel
                </button>
              </div>
            </Show>
          </Show>
          </Show>
        </div>

        <Show when={call()}>
          {(c) => (
            <div class="call-bar">
              <button class="call-bar-where" type="button" title="Go to your videochat" onClick={goToCall}>
                <span class="live-dot" aria-hidden="true" />
                <span class="call-bar-text">
                  <b>Connected</b>
                  <small>{c().channel.name}</small>
                </span>
              </button>
              <button
                class="icon-btn call-bar-leave"
                type="button"
                title="Disconnect"
                aria-label="Disconnect"
                onClick={() => setCall(undefined)}
              >
                ✕
              </button>
            </div>
          )}
        </Show>
        <footer class={`me self-nameplate ${nameplateClass(customization(profiles().get(props.uid)?.customization).nameplate)}`}>
          <SelfControls uid={props.uid} profile={profiles().get(props.uid)} name={nameOf(props.uid)} onProfile={event => openCard(props.uid, event)} onAccount={() => setModal("me")} />
        </footer>
      </aside>

      <div class="scrim" onClick={() => setNavOpen(false)} />

      {/* ---- the channel ---- */}
      <main class="main" onTouchStart={startCallSwipe} on:touchmove={moveCallSwipe} onTouchEnd={endCallSwipe} onTouchCancel={() => {callSwipe=undefined;}}>
        <header class="main-head">

          <button class="icon-btn menu-btn" type="button" aria-label="Channels" onClick={() => setNavOpen(true)}>
            ☰
          </button>
          <Show
            when={isDm(server()) && server()}
            fallback={
              <span class="main-title">
                <span class="hash">{channel()?.kind === "room" ? "▣" : channel()?.kind === "voice" ? "◉" : "#"}</span>{" "}
                {channel()?.name ?? ""}
              </span>
            }
          >
            {(d) => (
              <>
                <span class="main-title">
                  <span class="hash">@</span> {dmName(d())}<DeveloperBadge username={profiles().get(dmPartner(d(), props.uid))?.username} />
                </span>
                <button
                  class="btn dm-call-btn"
                  type="button"
                  title={channelId() === DM_CALL ? "Back to the messages" : "Videochat with them"}
                  onClick={() => pickChannel(channelId() === DM_CALL ? DM_CHAT : DM_CALL)}
                >
                  {channelId() === DM_CALL ? "Messages" : "📞 Call"}
                </button>
              </>
            )}
          </Show>
          <Notifications uid={props.uid} admin={props.admin} unreadInbox={unreadDms()} latestInboxAt={Math.max(0,...dms().filter(d => dmUnread(d.id)).map(d => latest().get(d.id)?.at ?? 0))} onOpen={() => openFeedback()} onItems={setNotificationItems} onError={setNotificationError} />
          {/* who committed, pushed and deployed what (owner, admins, developers) */}
          <Show when={props.admin || props.developer}>
            <ActivityButton uid={props.uid} />
          </Show>
          <Show when={tileChat()}>
            {(chat) => (
              <button
                class="btn side-chat-btn"
                classList={{ unread: unread() }}
                type="button"
                aria-pressed={sideChatOpen()}
                onClick={() => setSideChatOpen(!sideChatOpen())}
              >
                # {chat().name}
              </button>
            )}
          </Show>
        </header>
        <Switch fallback={<div class="main-empty">Pick a channel.</div>}>
          <Match when={dmHome() && !isDm(server())}>
            <div class="main-empty">Pick a conversation, or start one with + (or Message on a profile card).</div>
          </Match>
          <Match when={server() && channel()?.kind === "text" && channel()}>
            {(ch) => (
              <Chat
                serverId={server()!.id}
                channel={ch()}
                uid={props.uid}
                profiles={profiles()}
                canModerate={runsServer()}
              emojis={emojis()}
              members={server()?.memberUids}
              />
            )}
          </Match>
          {/* your call is showing (it lives below, outside the channel switch) */}
          <Match when={inThisCall()}>{null}</Match>
          <Match when={server() && (channel()?.kind === "voice" || channel()?.kind === "room") && channel()}>
            {(ch) => (
              <div class="voice">
                <div class="voice-lobby">
                  <h2>
                    {ch().kind === "room" ? "▣" : "◉"} {ch().name}
                  </h2>
                  <p>Join the videochat. Your mic and camera stay off until you turn them on.</p>
                  <button class="btn primary" type="button" onClick={() => joinCall(server()!.id, ch())}>
                    {call() ? "Move here" : "Join"}
                  </button>
                </div>
              </div>
            )}
          </Match>
        </Switch>
        {/* The one call. Reading another channel only hides it: the call (and
            the room page in it) keeps running, so nobody drops out. */}
        <Show when={call()} keyed>
          {(c) => (
            <div class="call-host" classList={{ away: !inThisCall() }}>
              {c.channel.kind === "room" ? (
                <RoomPane
                  serverId={c.serverId}
                  channel={c.channel}
                  uid={props.uid}
                  name={nameOf(props.uid)}
                  username={props.username}
                  profiles={profiles()}
                  teams={teamsIn(c.serverId, c.channel.id)}
                  onLeave={() => setCall(undefined)}
                />
              ) : (
                <VoiceRoom
                  serverId={c.serverId}
                  channel={c.channel}
                  uid={props.uid}
                  name={nameOf(props.uid)}
                  profiles={profiles()}
                  teams={teamsIn(c.serverId, c.channel.id)}
                  autoJoin
                  onLeave={() => setCall(undefined)}
                />
              )}
            </div>
          )}
        </Show>
      </main>

      {/* ---- right: the open tile's chat, otherwise the people. It slides
          out of the way; the strip at the screen's right edge brings it in. ---- */}
      <div class="right-edge" aria-hidden="true" onMouseEnter={e => { if (edgeHover() || e.clientY >= window.innerHeight * 0.28 && e.clientY <= window.innerHeight * 0.80) enterRight(); }} onMouseLeave={leaveRight} />
      <Show when={server() && tileChat()}>
        {(chat) => (
          <aside
            class="side-chat"
            data-mobile-panel={mobilePanel()}
            aria-label={`# ${chat().name}`}
            onMouseEnter={e => { if (edgeHover() || e.clientY >= window.innerHeight * 0.28 && e.clientY <= window.innerHeight * 0.80) enterRight(); }}
            onMouseLeave={leaveRight}
          >
            <header class="side-chat-head">
              <span>
                <span class="hash">#</span> {chat().name}
              </span>
              <PinButton pinned={rightPinned()} onPin={pinRight} />
              <button
                class="icon-btn side-chat-close"
                type="button"
                aria-label="Close chat"
                onClick={() => setSideChatOpen(false)}
              >
                ✕
              </button>
            </header>
            <div class="mobile-panel-switch" role="group" aria-label="Chat or people">
              <div class="mobile-panel-track" classList={{"people-selected":mobilePanel() === "people"}}>
                <button type="button" aria-pressed={mobilePanel() === "chat"} onClick={() => setMobilePanel("chat")}>Chat</button>
                <button type="button" aria-pressed={mobilePanel() === "people"} onClick={() => setMobilePanel("people")}>People <span>{onlineHere().length}</span></button>
              </div>
            </div>
            {/* the first TV on in this tile's Darkwood Room, above everything (Kaalob) */}
            <Show when={channel() && hasDarkwoodRoom(channel()!) ? channel()!.id : undefined}>
              {(tileId) => <SideTv serverId={server()!.id} channelId={tileId()} profiles={profiles()} />}
            </Show>
            {/* who is online stays visible with a tile open, above its chat */}
            <div class="side-online">
              <Show when={runsServer()}>
                <button class="side-tool people-btn" type="button" onClick={() => setModal("people")}>
                  + People
                </button>
              </Show>
              <MemberGroup
                label={`Online — ${onlineHere().length}`}
                uids={onlineHere()}
                profiles={profiles()}
                nameOf={nameOf}
                whereOf={whereOf}
                online
                onPick={openCard}
              />
            </div>
            <Chat
              serverId={server()!.id}
              channel={chat()}
              uid={props.uid}
              profiles={profiles()}
              canModerate={runsServer()}
              emojis={emojis()}
              members={server()?.memberUids}
              compact
              onNewMessage={pingRight}
              catchPageDrops
              onDragging={setFileDrag}
              onProfile={openCard}
            />
          </aside>
        )}
      </Show>
      <aside
        class="members"
        aria-label="Members"
        classList={{ hidden: Boolean(tileChat()) }}
        onMouseEnter={e => { if (edgeHover() || e.clientY >= window.innerHeight * 0.28 && e.clientY <= window.innerHeight * 0.80) enterRight(); }}
        onMouseLeave={leaveRight}
      >
        <div class="members-head">
          <PinButton pinned={rightPinned()} onPin={pinRight} />
        </div>
        <Show when={server()}>
          {(s) => {
            const online = () => s().memberUids.filter(isOnline);
            const offline = () => s().memberUids.filter((u) => !isOnline(u));
            return (
              <>
                <Show when={runsServer()}>
                  <button class="side-tool people-btn" type="button" onClick={() => setModal("people")}>
                    + People
                  </button>
                </Show>
                <MemberGroup
                  label={`Online — ${online().length}`}
                  uids={online()}
                  profiles={profiles()}
                  nameOf={nameOf}
                  whereOf={whereOf}
                  online
                  onPick={openCard}
                />
                <MemberGroup
                  label={`Offline — ${offline().length}`}
                  uids={offline()}
                  profiles={profiles()}
                  nameOf={nameOf}
                  onPick={openCard}
                />
              </>
            );
          }}
        </Show>
      </aside>

      <Show when={card()}>
        {(c) => (
          <ProfileCard
            uid={c().uid}
            x={c().x}
            y={c().y}
            anchorRight={c().anchorRight}
            profile={profiles().get(c().uid)}
            name={nameOf(c().uid)}
            online={isOnline(c().uid)}
            onEdit={c().uid === props.uid ? () => { setCard(undefined); setCustomizeOpen(true); } : undefined}
            onMessage={c().uid !== props.uid ? () => void startDm(c().uid) : undefined}
            where={whereOf(c().uid)}
            owner={server()?.ownerUid === c().uid}
            onClose={() => setCard(undefined)}
          />
        )}
      </Show>

      {/* ---- dialogs ---- */}
      <NameDialog
        open={modal() === "new-server"}
        title="New server"
        label="Server name"
        action="Create"
        onClose={() => setModal("")}
        onSubmit={async (name) => {
          const id = await createServer(props.uid, name);
          setServerId(id);
        }}
      />
      <ServerSettingsDialog
        open={modal() === "rename"}
        server={server()}
        // the owner may delete a server, never the home server (Living Room tile)
        canDelete={Boolean(server() && server()!.ownerUid === props.uid && !roomTiles().some((c) => c.roomKey === "gestr-living"))}
        onClose={() => setModal("")}
      />
      <NewChannelDialog
        open={modal() === "new-channel"}
        onClose={() => setModal("")}
        onSubmit={(name, kind, extra) =>
          kind === "room"
            ? createRoomTile(serverId()!, name, channels().length, { image: extra.image!, url: extra.url! })
            : createChannel(serverId()!, name, kind, channels().length)
        }
      />
      <PeopleDialog
        open={modal() === "people"}
        onClose={() => setModal("")}
        server={server()}
        profiles={profiles()}
        uid={props.uid}
      />
      <NewDmDialog
        open={newDm()}
        onClose={() => setNewDm(false)}
        uid={props.uid}
        profiles={profiles()}
        isOnline={isOnline}
        onPick={(uid) => void startDm(uid)}
      />
      <FeedbackDialog
        open={feedbackOpen()}
        initialTab={feedbackTab()}
        notificationItems={notificationItems()}
        unreadMessages={unreadDms()}
        notifications={<NotificationList items={notificationItems()} error={notificationError()} unreadInbox={unreadDms()} onInbox={() => {setFeedbackOpen(false);goDms();}} onFeedback={tab => setFeedbackTab(tab)} />}
        onClose={() => setFeedbackOpen(false)}
        uid={props.uid}
        name={nameOf(props.uid)}
        username={props.username}
        admin={props.admin}
        where={
          feedbackWhere() ||
          [server()?.name, channel() ? `${channel()!.kind === "room" ? "tile" : "#"} ${channel()!.name}` : ""].filter(Boolean).join(" · ") ||
          "Darkwood Node"
        }
      />
      <Show when={customizeOpen()}><Customize uid={props.uid} profile={profiles().get(props.uid)} name={nameOf(props.uid)} onClose={() => setCustomizeOpen(false)} /></Show>
      <Modal title="Account" open={modal() === "me"} onClose={() => setModal("")}>
        <p class="modal-text">
          Signed in as <b>{nameOf(props.uid)}<DeveloperBadge username={props.username} /></b> (@{props.username || "member"}).
        </p>
        <fieldset class="field sidebar-mode"><legend>Sidebar behavior · left &amp; right</legend>
          <div class="kind-pick">
            <label><input type="radio" name="sidebar-mode" checked={rightMode() === "slide"} onChange={() => chooseSidebarMode("slide")} />Slides in and out</label>
            <label><input type="radio" name="sidebar-mode" checked={rightMode() === "hover"} onChange={() => chooseSidebarMode("hover")} />Show only on hover</label>
            <label><input type="radio" name="sidebar-mode" checked={rightMode() === "pinned"} onChange={() => chooseSidebarMode("pinned")} />Always show</label>
          </div>
          <small class="call-name-note">Applies to both sides. Hover-only closes when the pointer leaves; slides in and out stays open briefly. Touch devices keep their tap controls.</small>
        </fieldset>
        <div class="modal-actions">
          <button class="btn danger" type="button" onClick={props.onLogout}>
            Log out
          </button>
        </div>
      </Modal>
    </div>
  );
}

/** Keep the right sidebar always there, or let it slide away again. */
function PinButton(props: { pinned: boolean; onPin: (on: boolean) => void }) {
  return (
    <button
      type="button"
      class="icon-btn pin-btn"
      classList={{ on: props.pinned }}
      aria-pressed={props.pinned}
      title={props.pinned ? "Let the sidebar slide away" : "Keep the sidebar always showing"}
      aria-label={props.pinned ? "Let the sidebar slide away" : "Keep the sidebar always showing"}
      onClick={() => props.onPin(!props.pinned)}
    >
      📌
    </button>
  );
}

/**
 * A person's profile card, like Discord's: their colour across the top, the
 * big initials, name, @username, and whether (and where) they are online.
 * Click outside it or press Esc to close.
 */
export function ProfileCard(props: {
  uid: string;
  x: number;
  y: number;
  anchorRight?: number;
  profile?: Profile;
  name: string;
  online: boolean;
  where: string;
  owner: boolean;
  /** start (or open) a direct message with them */
  onMessage?: () => void;
  onEdit?: () => void;
  onClose: () => void;
}) {
  let panel: HTMLElement | undefined;
  const [viewport, setViewport] = createSignal({ width: window.innerWidth, height: window.innerHeight });
  const [height, setHeight] = createSignal(365);
  const width = () => Math.min(340, viewport().width - 24);
  const opensLeft = () => props.x >= width() + 24;
  const left = () => {
    const preferred = opensLeft() ? props.x - width() - 12 : (props.anchorRight ?? props.x) + 12;
    return Math.max(12, Math.min(preferred, viewport().width - width() - 12));
  };
  const top = () => Math.max(12, Math.min(props.y, viewport().height - height() - 12));
  onMount(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel?.focus();
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    const observer = new ResizeObserver(() => { if (panel) setHeight(panel.getBoundingClientRect().height); });
    if (panel) observer.observe(panel);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); props.onClose(); }
      if (e.key === "Tab" && panel) {
        const buttons = Array.from(panel.querySelectorAll<HTMLButtonElement>("button"));
        if (!buttons.length) { e.preventDefault(); return; }
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = (index + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        e.preventDefault(); buttons[next]?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", resize);
    onCleanup(() => { observer.disconnect(); window.removeEventListener("keydown", onKey); window.removeEventListener("resize", resize); previous?.focus(); });
  });
  return (
    <div class="card-backdrop" onClick={props.onClose}>
      <article
        ref={panel} role="dialog" aria-modal="true" tabIndex={-1}
        class={`profile-card profile-effect-${customization(props.profile?.customization).effect}`}
        style={{
          "--profile-enter-x": opensLeft() ? "28px" : "-28px",
          width: `${width()}px`,
          "max-height": `${viewport().height - 24}px`,
          left: `${left()}px`,
          top: `${top()}px`,
          ...(props.profile?.background
            ? {
                "background-image": `linear-gradient(rgba(11, 11, 11, 0.72), rgba(11, 11, 11, 0.93)), url("${props.profile.background}")`,
                "background-size": "cover",
                "background-position": "center",
              }
            : {}),
        }}
        onClick={(e) => e.stopPropagation()}
        aria-label={`${props.name}'s profile`}
      >
        <div class="profile-banner" style={pictureStyle(props.profile, "banner")} />
        <button class="profile-close icon-btn" type="button" aria-label="Close profile" onClick={props.onClose}>✕</button>
        <span class="avatar profile-avatar" style={faceStyle(props.profile)}>
          {faceText(props.profile, props.name)}
          <i class={`dot status-${props.online ? availabilityStatus(props.profile?.availability) : "invisible"}`} classList={{ off: !props.online }} />
        </span>
        <div class="profile-body">
          <div class="profile-identity"><h3>
            {props.name}<DeveloperBadge username={props.profile?.username} />
            <Show when={props.owner}>
              <span class="profile-badge">Owner</span>
            </Show>
          </h3>
          <p class="profile-user">@{props.profile?.username || "member"}</p></div>
          <div class="profile-section">
            <span class="group-label">Status</span>
            <p>{props.online ? props.where || "Online" : "Offline"}</p>
          </div>
          <Show when={props.onEdit}><button class="btn primary profile-message profile-edit" type="button" onClick={() => props.onEdit?.()}>✎ Edit Profile</button></Show>
          <Show when={props.onMessage}>
            <button class="btn primary profile-message" type="button" onClick={() => props.onMessage?.()}>
              Message
            </button>
          </Show>
        </div>
      </article>
    </div>
  );
}

function MemberGroup(props: {
  label: string;
  uids: string[];
  profiles: Map<string, Profile>;
  nameOf: (uid: string) => string;
  online?: boolean;
  /** where an online person is ("In Living Room", "Videochat · …") */
  whereOf?: (uid: string) => string;
  /** clicked: show their profile card */
  onPick?: (uid: string, at: MouseEvent) => void;
}) {
  return (
    <Show when={props.uids.length}>
      <div class="group-label">{props.label}</div>
      <For each={props.uids}>
        {(uid) => (
          <button
            type="button"
            class={`member ${nameplateClass(customization(props.profiles.get(uid)?.customization).nameplate)}`}
            classList={{ offline: !props.online }}
            onClick={(e) => props.onPick?.(uid, e)}
          >
            <span class="avatar small" style={faceStyle(props.profiles.get(uid))}>
              {faceText(props.profiles.get(uid), props.nameOf(uid))}
              <Show when={props.online}>
                <i class={`dot status-${availabilityStatus(props.profiles.get(uid)?.availability)}`} title={availabilityLabel(props.profiles.get(uid)?.availability)} />
              </Show>
            </span>
            <span class="member-text">
              <span class="member-name">{props.nameOf(uid)}<DeveloperBadge username={props.profiles.get(uid)?.username} /></span>
              <Show when={props.online && props.whereOf?.(uid)}>
                {(where) => <small class="member-where">{where()}</small>}
              </Show>
            </span>
          </button>
        )}
      </For>
    </Show>
  );
}

function NameDialog(props: {
  open: boolean;
  title: string;
  label: string;
  action: string;
  initial?: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<unknown>;
}) {
  const [error, setError] = createSignal("");
  return (
    <Modal title={props.title} open={props.open} onClose={props.onClose}>
      <form
        class="modal-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const name = String(new FormData(e.currentTarget).get("name") ?? "").trim().slice(0, 60);
          if (!name) return;
          try {
            setError("");
            await props.onSubmit(name);
            props.onClose();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not save that.");
          }
        }}
      >
        <label class="field">
          <span>{props.label}</span>
          <input name="name" value={props.initial ?? ""} maxLength={60} required />
        </label>
        <Show when={error()}>
          <p class="form-error">{error()}</p>
        </Show>
        <div class="modal-actions">
          <button class="btn" type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button class="btn primary" type="submit">
            {props.action}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function NewChannelDialog(props: {
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string, kind: Channel["kind"], extra: { image?: string; url?: string }) => Promise<unknown>;
}) {
  // Picture tiles all the way: a new channel is a tile.
  const [kind, setKind] = createSignal<Channel["kind"]>("room");
  const [image, setImage] = createSignal("");
  const [error, setError] = createSignal("");

  async function pickImage(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      setError("");
      setImage(await shrinkImage(file));
    } catch (err) {
      setImage("");
      setError(err instanceof Error ? err.message : "Could not read that image");
    }
  }

  const close = () => {
    setKind("room");
    setImage("");
    setError("");
    props.onClose();
  };

  return (
    <Modal title="New channel" open={props.open} onClose={close}>
      <form
        class="modal-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const name = String(form.get("name") ?? "").trim().slice(0, 40);
          if (!name) return;
          const extra: { image?: string; url?: string } = {};
          if (kind() === "room") {
            const url = String(form.get("url") ?? "").trim();
            if (!/^https?:\/\//i.test(url)) return setError("Use a full link, starting with https://");
            if (!image()) return setError("Choose a picture for the tile");
            extra.url = url;
            extra.image = image();
          }
          try {
            await props.onSubmit(name, kind(), extra);
            close();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not create that.");
          }
        }}
      >
        <label class="field">
          <span>Channel name</span>
          <input name="name" maxLength={40} required />
        </label>
        <Show when={kind() === "room"}>
          <p class="modal-text">
            A picture in the channel list. Clicking it opens a video chat, with a toggle to the room page at this link.
          </p>
          <label class="field">
            <span>Room link</span>
            <input name="url" type="url" placeholder="https://" />
          </label>
          <label class="field">
            <span>Picture</span>
            <input type="file" accept="image/*" onChange={pickImage} />
          </label>
          <Show when={image()}>
            <img class="tile-preview" src={image()} alt="" />
          </Show>
        </Show>
        <Show when={error()}>
          <p class="form-error">{error()}</p>
        </Show>
        <div class="modal-actions">
          <button class="btn" type="button" onClick={close}>
            Cancel
          </button>
          <button class="btn primary" type="submit">
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** The server's name and banner (the picture across the top of its channels). */
function ServerSettingsDialog(props: { open: boolean; server?: Server; canDelete: boolean; onClose: () => void }) {
  // undefined = banner untouched, null = remove it, string = the new picture
  const [banner, setBanner] = createSignal<string | null | undefined>();
  const [error, setError] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [uploading, setUploading] = createSignal(false);
  // Delete takes two clicks: the first arms it, the second deletes.
  const [deleteArmed, setDeleteArmed] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const shown = () => (banner() === undefined ? props.server?.banner : banner() ?? undefined);

  const close = () => {
    setBanner(undefined);
    setError("");
    setDeleteArmed(false);
    props.onClose();
  };

  async function removeServer() {
    if (!props.server) return;
    if (!deleteArmed()) {
      setDeleteArmed(true);
      return;
    }
    setDeleting(true);
    try {
      await deleteServer(props.server.id);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the server.");
    } finally {
      setDeleting(false);
    }
  }

  async function pick(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || !props.server) return;
    setUploading(true);
    setError("");
    try {
      setBanner(await uploadPicture(file, { kind: "banner", serverId: props.server.id }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not use that picture");
    } finally {
      setUploading(false);
    }
  }

  return (
    <Modal title="Server settings" open={props.open} onClose={close}>
      <form
        class="modal-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const name = String(form.get("name") ?? "").trim().slice(0, 60);
          if (!name || !props.server) return;
          setSaving(true);
          try {
            await saveServerSettings(props.server.id, name, banner(), form.get("open") === "on");
            close();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not save that.");
          } finally {
            setSaving(false);
          }
        }}
      >
        <label class="field">
          <span>Server name</span>
          <input name="name" value={props.server?.name ?? ""} maxLength={60} required />
        </label>
        <label class="check-row">
          <input type="checkbox" name="open" checked={Boolean(props.server?.open)} />
          <span>
            <b>Open to everyone who gets in</b>
            <small>Every approved member (past the M2A-access door) joins this server on their own.</small>
          </span>
        </label>
        <div class="field">
          <span>Banner</span>
          <div class="banner-preview">
            <Show when={shown()} fallback={<div class="banner-empty">No banner</div>}>
              {(src) => <img src={src()} alt="" />}
            </Show>
          </div>
          <div class="banner-actions">
            <label class="btn banner-upload">
              {uploading() ? "Uploading…" : shown() ? "Change picture" : "Upload picture"}
              <input type="file" accept="image/*" disabled={uploading()} onChange={pick} />
            </label>
            <Show when={shown()}>
              <button class="btn danger" type="button" onClick={() => setBanner(null)}>
                Remove
              </button>
            </Show>
          </div>
          <small class="field-hint">Wide pictures work best (about 3 : 1). A GIF keeps moving.</small>
        </div>
        <Show when={props.canDelete}>
          <div class="field">
            <span>Delete</span>
            <div class="banner-actions">
              <button class="btn danger" type="button" disabled={deleting()} onClick={() => void removeServer()}>
                {deleting() ? "Deleting…" : deleteArmed() ? "Click again to delete for good" : "Delete server"}
              </button>
            </div>
            <small class="field-hint">Removes this server, its channels and all their messages.</small>
          </div>
        </Show>
        <Show when={error()}>
          <p class="form-error">{error()}</p>
        </Show>
        <div class="modal-actions">
          <button class="btn" type="button" onClick={close}>
            Cancel
          </button>
          <button class="btn primary" type="submit" disabled={saving()}>
            {saving() ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** The server's owner adds or removes approved members. */
function PeopleDialog(props: {
  open: boolean;
  onClose: () => void;
  server?: Server;
  profiles: Map<string, Profile>;
  uid: string;
}) {
  const everyone = () =>
    [...props.profiles.values()].sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const inServer = (uid: string) => Boolean(props.server?.memberUids.includes(uid));
  return (
    <Modal title="People in this server" open={props.open} onClose={props.onClose}>
      <p class="modal-text">Everyone here is an approved member. Add them to let them see this server.</p>
      <div class="people-list">
        <For each={everyone()}>
          {(p) => (
            <div class="person">
              <span class="avatar small" style={faceStyle(p)}>
                {faceText(p, displayName(p))}
              </span>
              <span class="member-name">
                {displayName(p)}<DeveloperBadge username={p.username} /> <small>@{p.username}</small>
              </span>
              <Show
                when={inServer(p.uid)}
                fallback={
                  <button class="btn" type="button" onClick={() => void addServerMembers(props.server!.id, [p.uid])}>
                    Add
                  </button>
                }
              >
                <Show when={p.uid !== props.server?.ownerUid} fallback={<span class="person-tag">owner</span>}>
                  <button class="btn danger" type="button" onClick={() => void removeServerMember(props.server!.id, p.uid)}>
                    Remove
                  </button>
                </Show>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Modal>
  );
}

/** New message: pick anyone approved (searchable) to start a DM with. */
function NewDmDialog(props: {
  open: boolean;
  onClose: () => void;
  uid: string;
  profiles: Map<string, Profile>;
  isOnline: (uid: string) => boolean;
  onPick: (uid: string) => void;
}) {
  const [q, setQ] = createSignal("");
  const people = () =>
    [...props.profiles.values()]
      .filter((p) => p.uid !== props.uid)
      .filter((p) => !q().trim() || `${displayName(p)} ${p.name} ${p.username}`.toLowerCase().includes(q().trim().toLowerCase()))
      .sort((a, b) => Number(props.isOnline(b.uid)) - Number(props.isOnline(a.uid)) || displayName(a).localeCompare(displayName(b)));
  return (
    <Modal title="New message" open={props.open} onClose={props.onClose}>
      <div class="modal-form">
        <label class="field">
          <span>Who do you want to message?</span>
          <input value={q()} onInput={(e) => setQ(e.currentTarget.value)} placeholder="Search names" />
        </label>
        <div class="people-list">
          <For each={people()}>
            {(p) => (
              <button type="button" class="member" onClick={() => props.onPick(p.uid)}>
                <span class="avatar small" style={faceStyle(p)}>
                  {faceText(p, displayName(p))}
                  <Show when={props.isOnline(p.uid)}>
                    <i class={`dot status-${availabilityStatus(props.profiles.get(p.uid)?.availability)}`} title={availabilityLabel(props.profiles.get(p.uid)?.availability)} />
                  </Show>
                </span>
                <span class="member-text">
                  <span class="member-name">
                    {displayName(p)}<DeveloperBadge username={p.username} /> <small>@{p.username}</small>
                  </span>
                </span>
              </button>
            )}
          </For>
        </div>
      </div>
    </Modal>
  );
}
