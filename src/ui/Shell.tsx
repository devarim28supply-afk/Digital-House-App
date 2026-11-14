
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
  createRoomTile,
  createServer,
  deleteRoomTile,
  announceJoinRequest,
  ensureHomeServer,
  serverListError,
  markJoinRequestAnnounced,
  syncDirectoryEntry,
  watchJoinRequests,
  type JoinRequest,
  ensureServerTiles,
  isHomeServer,
  isTvChannel,
  topRoleOf,
  TV_TILE_IMAGE,
  VIDEOCHAT_TILE_IMAGE,
  restoreHomeMembers,
  lookupInvite,
  redeemInvite,
  setInviteCode,
  setServerOpen,
  imageSrc,
  hiddenFromSidebar,
  isBuiltInTile,
  removeServerMember,
  saveServerSettings,
  setAnnouncement,
  deleteServer,
  saveProfile,
  shrinkImage,
  startPresence,
  watchChannels,
  displayName,
  watchEmojis,
  watchPresence,
  watchProfiles,
  watchServers,
  hasDarkwoodRoom,
} from "../data/store";
import { uploadPicture } from "../data/files";
import { LEFT_WIDTH, RIGHT_WIDTH, access, setAccess } from "../data/access";
import { userPrefs } from "../data/prefs";
import { Settings } from "./Settings";
import { ServerSettings } from "./ServerSettings";
import { Chat } from "./Chat";
import { DM_CALL, DM_CHAT, dmPartner, isDm, markRead, openDm, readTimes, watchLatest } from "../data/dms";
import { FeedbackDialog } from "./Feedback";
import { Modal } from "./Modal";
import { FindServer, FindServerDialog } from "./FindServer";
import { JoinRequestList } from "./JoinRequests";
import { RoomPane, type RoomPaneToggle } from "./RoomPane";
import { VoiceRoom } from "./VoiceRoom";
import { auth } from "../firebase";
import { OWNER_EMAIL } from "../firebase-config.js";
import { DashboardDialog, type Page as DashboardPage, type Section as DashboardSection } from "./Dashboard";
import { setCanRemoveFromCall, setTvRemoteOpen, setWatchRequest, streamingIn, tvRemoteAvailable, tvRemoteOpen, whereNow } from "../data/where";
import { LiveTile } from "./LiveTile";
import { SideTv } from "./SideTv";

import { CallPopup, type IncomingCall } from "./CallPopup";
import { buzz, desktopNotify, pushAlert } from "../data/alerts";
import "./app.css";

const LAST_SERVER_KEY = "dh_last_server";
const lastChannelKey = (sid: string) => `dh_last_channel_${sid}`;
// near the top and bottom of the screen, a side bar slides in only from this close to the side edge
const EDGE_REACH_NARROW = 28;
const RIGHT_MODE_KEY = "dh_right_mode";
const RIGHT_WIDE_KEY = "dh_right_wide";
const LEFT_MODE_KEY = "dh_left_mode";
type SidebarMode = "slide" | "pinned" | "hover";
// a tile shows up to this many faces, then "+N"
const TILE_FACES = 5;
// other names a tile's room goes by in people's "where"
const TILE_ALIASES: Record<string, string[]> = {
  // The tile was Living Room. People already standing there still count.
  "gestr-living": ["Living Room"],
};
// how long a new chat message keeps the right sidebar slid in
const RIGHT_HOLD_MS = 30_000;
// how long it stays after the mouse leaves it
const RIGHT_LINGER_MS = 5_000;
// Both Living Room and Wall Street are ready for real use now - neither
// is on this list. Add a roomKey back here if a room needs to come down
// for rework (a plain "under construction" message instead of opening).
const UNDER_CONSTRUCTION = new Set<string>([]);

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

/** What fills a tile behind the avatar while their camera is off: their picture or GIF, else their color, else the default. */
export function cameraOffStyle(profile: Profile | undefined): JSX.CSSProperties {
  const color = customization(profile?.customization).cameraOffColor;
  const image = profile?.cameraOffImage;
  const usable = image && (/^https:\/\//.test(image) || image.startsWith("blob:"));
  return {
    ...(color ? { "background-color": color } : {}),
    ...(usable ? { "background-image": `url(${JSON.stringify(image)})`, "background-size": "cover", "background-position": "center" } : {}),
  };
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
const LINK_RE = /((?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|net|org|app|dev|io|co|gg|tv|me|us|ai)(?:\/[^\s]*)?)/gi;
/** Text with its web addresses turned into links (https:// is assumed when missing). */
function linkify(text: string): JSX.Element[] {
  return text.split(LINK_RE).map((part, i) => {
    if (i % 2 === 0) return <>{part}</>;
    const trail = part.match(/[.,!?;:)]+$/)?.[0] ?? "";
    const url = trail ? part.slice(0, -trail.length) : part;
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    return (
      <>
        <a href={href} target="_blank" rel="noopener noreferrer">{url}</a>
        {trail}
      </>
    );
  });
}

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
export function Shell(props: { uid: string; admin: boolean; staff?: boolean; developer?: boolean; name: string; username: string; onLogout: () => void }) {
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
    // The channel list has no button. A right swipe on the page opens it.
    // On a call, the first right swipe is your camera and the call keeps that
    // touch. The next right swipe, while you are on your camera, reaches here.
    if(!window.matchMedia("(max-width:760px)").matches || event.touches.length !== 1 || !target?.closest(".main") || target.closest("button,input,textarea,a,[role=slider],.dock-menu,.inset-resize,video[controls]")) {callSwipe=undefined;return;}
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
  const [modal, setModal] = createSignal<"" | "new-server" | "join" | "find" | "rename" | "people" | "new-channel" | "me">("");
  // Feedback for the developers: from the top bar, or the Darkwood Room's
  // own button (it asks this page to open it), or /app/?feedback
  const [feedbackOpen, setFeedbackOpen] = createSignal(new URLSearchParams(location.search).has("feedback"));
  const [notificationItems, setNotificationItems] = createSignal<Notice[]>([]);
  const [notificationError, setNotificationError] = createSignal("");
  const [feedbackTab, setFeedbackTab] = createSignal<"send" | "mine">("send", { equals: false });
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
  // The Videochat/Room toggle lives here, in the header, but the actual pane
  // state (and everything switching it touches) stays owned by RoomPane.
  const [roomToggle, setRoomToggle] = createSignal<RoomPaneToggle | undefined>();
  function joinCall(serverId: string, ch: Channel) {
    // the same channel id can be in two places (every DM's call is "call")
    if (call()?.serverId === serverId && call()?.channel.id === ch.id) return;
    setCall({ serverId, channel: ch });
    // On a phone the channel list and the right-side chat are drawers with
    // no close button (swipe only) sitting over the call. Leaving either
    // open when a call starts means the video and dock sit directly behind
    // it with nothing to dismiss it - close both the moment the call does.
    setNavOpen(false);
    setSideChatOpen(false);
  }
  function goToCall() {
    const c = call();
    if (!c) return;
    remember(lastChannelKey(c.serverId), c.channel.id);
    if (serverId() === c.serverId) setChannelId(c.channel.id);
    else setServerId(c.serverId);
    setNavOpen(false);
  }

  const [waiting, setWaiting] = createSignal<Record<string, JoinRequest[]>>({});
  const waitingCount = (sid: string) => waiting()[sid]?.length ?? 0;
  const announced = new Set<string>();
  createEffect(() => {
    const mine = realServers().filter((s) => s.ownerUid === props.uid || props.admin || props.staff);
    const stops = mine.map((s) =>
      watchJoinRequests(s.id, (list) => {
        setWaiting((prev) => ({ ...prev, [s.id]: list }));
        if (s.ownerUid !== props.uid) return;
        // Server settings > Engagement: no chat message when someone asks to join
        if (s.announceJoins === false) return;
        for (const request of list) {
          const key = `${s.id}/${request.uid}`;
          if (request.announced || announced.has(key)) continue;
          announced.add(key);
          void announceJoinRequest(s.id, props.uid, request.name, request.username)
            .then(() => markJoinRequestAnnounced(s.id, request.uid))
            .catch(() => announced.delete(key));
        }
      }),
    );
    onCleanup(() => stops.forEach((stop) => stop()));
  });
  // the search list shows the NAME of every server; its owner keeps the entry current (and fills it in for older servers)
  const syncedNames = new Map<string, string>();
  createEffect(() => {
    for (const s of realServers()) {
      if (s.ownerUid !== props.uid || s.unlisted || syncedNames.get(s.id) === s.name) continue;
      syncedNames.set(s.id, s.name);
      void syncDirectoryEntry(s.id, s.name).catch(() => syncedNames.delete(s.id));
    }
  });

  onMount(() => {
    void saveProfile(props.uid, props.name, props.username);
    // The operator makes Digital House first (it is private; people ask to join).
    void (async () => {
      if (props.admin) await ensureHomeServer(props.uid).catch(() => {});
    })();
    const me = startPresence(props.uid);
    // tell everyone where you are: a call or a room's Room view
    // (and in which server: every server has a Node Lounge and a Living Room)
    // Settings > Privacy: with "show where I am" off, no place is told at all
    createEffect(() => me.setWhere(userPrefs().shareWhere ? whereNow() : "", call()?.serverId ?? ""));
    // the open call shows its Remove button to the server's owner and to admins
    createEffect(() => {
      const c = call();
      const s = c && servers().find((x) => x.id === c.serverId);
      setCanRemoveFromCall(Boolean(s && s.kind !== "dm" && (props.admin || s.ownerUid === props.uid)));
    });
    onCleanup(() => setCanRemoveFromCall(false));
    // in a videochat: the people it is for get an incoming-call popup
    const callSince = createMemo(() => (call() ? Date.now() : 0));
    createEffect(() => {
      const c = call();
      const sv = c && servers().find((x) => x.id === c.serverId);
      me.setCalling(c && sv ? { serverId: c.serverId, channelId: c.channel.id, channelName: c.channel.name, serverName: isDm(sv) ? "" : sv.name, at: callSince() } : null);
    });
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
  const [latest, setLatest] = createSignal(new Map<string, { at: number; author: string; text: string }>());
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
  // Message a staff member from the Dashboard's Staff list: close the
  // Dashboard, then the same thing starting a DM anywhere else does.
  function dashboardMessage(uid: string) {
    setDashboardOpen(false);
    void startDm(uid);
  }
  // The joined server shows up on the next member-list snapshot. Switch to it then.
  const [pendingJoin, setPendingJoin] = createSignal("");
  createEffect(() => {
    const id = pendingJoin();
    if (id && servers().some((s) => s.id === id)) {
      openServer(id);
      setPendingJoin("");
    }
  });
  function goDms() {
    setDmHome(true);
    const first = dmsByLatest()[0];
    if (first && !isDm(server())) setServerId(first.id);
    // Landing on a real conversation is a destination, same as picking a
    // channel (pickChannel) or a DM row (below) - on a phone, where the
    // rail and channel list are a drawer over the chat, it has to close
    // the same way those do, or the chat it just opened stays hidden
    // behind the drawer with no button to dismiss it (nav is swipe-only).
    if (isDm(server())) setNavOpen(false);
  }

  // Keep a valid server picked.
  createEffect(() => {
    const list = servers();
    if (!list.length) return;
    if (!list.some((s) => s.id === serverId())) setServerId((realServers()[0] ?? list[0]).id);
  });

  const server = createMemo(() => servers().find((s) => s.id === serverId()));
  // in a DM nobody runs anything: no settings, tiles or people to add
  // only the owner account hands out roles
  const isOwnerAccount = () => (auth.currentUser?.email ?? "").toLowerCase() === OWNER_EMAIL;
  const [editingAnnouncement, setEditingAnnouncement] = createSignal(false);
  const [announcementDraft, setAnnouncementDraft] = createSignal("");
  const [dashboardOpen, setDashboardOpen] = createSignal(false);
  const [dashboardPage, setDashboardPage] = createSignal<DashboardPage>("insights", { equals: false });
  const [dashboardFocus, setDashboardFocus] = createSignal<DashboardSection | undefined>(undefined, { equals: false });
  function openDashboard(page: DashboardPage = "insights", focus?: DashboardSection) {
    setDashboardPage(page);
    setDashboardFocus(focus);
    setDashboardOpen(true);
  }
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
    const stop = watchChannels(sid, (list, early) => {
      setChannels(list);
      // Every server's built-in tiles, added once for servers made before
      // them: Node Lounge and Living Room. Its owner adds them; an admin
      // does too on any server but the home one (isHomeServer). Never from
      // the browser's early copy of the list, which can be missing channels.
      const s = servers().find((x) => x.id === sid);
      const isHome = isHomeServer(s, list);
      if (!tileChecked && !early && s && !isDm(s) && (s.ownerUid === props.uid || (props.admin && !isHome))) {
        tileChecked = true;
        void ensureServerTiles(sid, list, isHome).catch(() => {});
        // Approved members who were already in Digital House go back on the list.
        if (isHome) void restoreHomeMembers(sid).catch(() => {});
      }
      const current = channelId();
      if (current && list.some((c) => c.id === current)) return;
      const saved = recall(lastChannelKey(sid));
      // only picture tiles are shown: reopen the last tile, else the first.
      // Don't Lie, White Torture, and Viper 11 stay off this list for now.
      const shown = (c: Channel) => c.kind === "room" && !hiddenFromSidebar(c);
      const pick = list.find((c) => c.id === saved && shown(c)) ?? list.find(shown) ?? list[0];
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
    if (sid && ch && (ch.kind === "room" || ch.kind === "voice") && !UNDER_CONSTRUCTION.has(ch.roomKey ?? "")) joinCall(sid, ch);
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
  // Each side keeps its own mode (its pin pins only that side, Kaalob); the
  // Account setting, which sets both at once, is what a side starts from.
  const savedLeftMode = recall(LEFT_MODE_KEY) ?? recall("dh_sidebar_mode");
  const [leftMode, setLeftMode] = createSignal<SidebarMode>(savedLeftMode === "pinned" || savedLeftMode === "hover" ? savedLeftMode : "slide");
  const leftPinned = () => leftMode() === "pinned";
  function chooseLeftMode(mode: SidebarMode) {
    window.clearTimeout(leftTimer); leftTimer = 0;
    setLeftMode(mode); setLeftHover(false);
    remember(LEFT_MODE_KEY, mode);
  }
  // unpinned, a side goes back to sliding (or to hover-only, if that is the Account setting)
  const unpinnedMode = (): SidebarMode => (recall("dh_sidebar_mode") === "hover" ? "hover" : "slide");
  const pinLeft = (on: boolean) => chooseLeftMode(on ? "pinned" : unpinnedMode());
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
  const savedRightMode = recall(RIGHT_MODE_KEY) ?? recall("dh_sidebar_mode");
  const [rightMode, setRightMode] = createSignal<SidebarMode>(savedRightMode === "pinned" || savedRightMode === "hover" ? savedRightMode : "slide");
  const rightPinned = () => rightMode() === "pinned";
  // The right sidebar can be made bigger toward the left: a third of the
  // screen (Kaalob). The button beside the pin; remembered in this browser.
  const [rightWide, setRightWide] = createSignal(recall(RIGHT_WIDE_KEY) === "1");
  const widenRight = (on: boolean) => {
    setRightWide(on);
    remember(RIGHT_WIDE_KEY, on ? "1" : "0");
    // the button is "a third of the screen" or "normal": either way a dragged width goes
    setAccess({ rightWidth: 0 });
  };
  // The right sidebar sized to your liking (Accessibility): drag its inner
  // edge. The width is kept (data/access.ts) and given to the layout as a
  // variable on the shell; a double-click on the edge puts it back. Only the
  // right one (Kaalob): the left sidebar keeps its own width.
  const [sizing, setSizing] = createSignal<"left" | "right" | undefined>();
  function startSizing(which: "left" | "right", e: PointerEvent) {
    if (e.button !== 0) return;
    const handle = e.currentTarget as HTMLElement;
    const panel = handle.parentElement;
    const shell = handle.closest<HTMLElement>(".shell");
    if (!panel || !shell) return;
    e.preventDefault();
    // the shell is drawn zoomed: the pointer moves in screen pixels, the width is in the shell's own
    const zoom = parseFloat(getComputedStyle(shell).zoom) || 1;
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width / zoom;
    const maxRight = Math.min(RIGHT_WIDTH.max, (window.innerWidth / zoom) * 0.6);
    setSizing(which);
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / zoom;
      if (which === "left") setAccess({ leftWidth: Math.round(Math.min(LEFT_WIDTH.max, Math.max(LEFT_WIDTH.min, startW + dx))) });
      else setAccess({ rightWidth: Math.round(Math.min(maxRight, Math.max(RIGHT_WIDTH.min, startW - dx))) });
    };
    const done = () => {
      setSizing(undefined);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
  }
  const Sizer = (p: { side: "left" | "right" }) => (
    <div
      class={`side-sizer ${p.side}`}
      classList={{ dragging: sizing() === p.side }}
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize this sidebar. Double-click to put it back."
      onPointerDown={(e) => startSizing(p.side, e)}
      onDblClick={() => setAccess(p.side === "left" ? { leftWidth: 0 } : { rightWidth: 0 })}
    />
  );
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
  const pinRight = (on: boolean) => chooseRightMode(on ? "pinned" : unpinnedMode());

  const isOnline = (uid: string) => availabilityStatus(profiles().get(uid)?.availability) !== "invisible" && now() - (presence().get(uid)?.lastSeen ?? 0) < ONLINE_WINDOW_MS;
  // where an online person is; a place older than the window has expired
  const whereOf = (uid: string) => {
    if (availabilityStatus(profiles().get(uid)?.availability) === "invisible") return "";
    const p = presence().get(uid);
    return p?.where && now() - p.whereAt < ONLINE_WINDOW_MS ? p.where : "";
  };
  const onlineHere = () => server()?.memberUids.filter(isOnline) ?? [];
  const offlineHere = () => server()?.memberUids.filter((uid) => !isOnline(uid)) ?? [];
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
  // videochat (their "where").
  const peopleIn = (tile: Channel) => {
    const names = [tile.name, ...(TILE_ALIASES[tile.roomKey ?? ""] ?? [])];
    const places = new Set(names.flatMap((n) => [`In ${n}`, `Videochat · ${n}`]));
    // every server has a Node Lounge and a Living Room: only the people in
    // this server's (a 3D room's own page names no server, and still counts)
    const here = (uid: string) => {
      const sid = presence().get(uid)?.whereSid;
      return !sid || sid === serverId();
    };
    return onlineHere().filter((uid) => here(uid) && places.has(whereOf(uid)));
  };
  const nameOf = (uid: string) => displayName(profiles().get(uid), uid === props.uid ? props.name : "Member");

  // ---- alerts: a new direct message, someone asking to join, and incoming calls ----
  const dnd = () => availabilityStatus(profiles().get(props.uid)?.availability) === "dnd";
  const appStart = Date.now();
  const notifiedAt = new Map<string, number>();
  createEffect(() => {
    for (const [id, l] of latest()) {
      if (l.author === props.uid || l.at <= appStart || (notifiedAt.get(id) ?? 0) >= l.at) continue;
      notifiedAt.set(id, l.at);
      if (dnd() || (serverId() === id && channelId() === DM_CHAT && document.visibilityState === "visible")) continue;
      const open = () => {
        setDmHome(true);
        remember(lastChannelKey(id), DM_CHAT);
        setServerId(id);
      };
      pushAlert({ id: `dm-${id}`, title: nameOf(l.author), detail: l.text || "New message", onClick: open });
      desktopNotify(nameOf(l.author), l.text || "New message", open);
      buzz([200]);
    }
  });
  const askedBefore = new Set<string>();
  let askedFirst = true;
  createEffect(() => {
    const all = waiting();
    for (const [sid, list] of Object.entries(all)) {
      for (const r of list) {
        const key = `${sid}:${r.uid}`;
        if (askedBefore.has(key)) continue;
        askedBefore.add(key);
        if (askedFirst || dnd()) continue;
        const sv = servers().find((x) => x.id === sid);
        pushAlert({ id: `join-${key}`, title: `${r.name} wants to join`, detail: sv?.name ?? "your server" }, 10000);
        desktopNotify(`${r.name} wants to join`, sv?.name ?? "your server");
      }
    }
    if (Object.keys(all).length) askedFirst = false;
  });
  const [dismissedCalls, setDismissedCalls] = createSignal(new Set<string>());
  const incomingCalls = createMemo<IncomingCall[]>(() => {
    const out: IncomingCall[] = [];
    const here = call();
    for (const [uid, p] of presence()) {
      const c = p.calling;
      if (!c || uid === props.uid || now() - p.lastSeen > ONLINE_WINDOW_MS) continue;
      const sv = servers().find((x) => x.id === c.serverId);
      if (!sv || (here?.serverId === c.serverId && here.channel.id === c.channelId)) continue;
      const key = `${uid}:${c.at}`;
      if (dismissedCalls().has(key)) continue;
      const direct = isDm(sv);
      if (!direct) {
        // a server call: only tell people when its first person starts it, and not while you are set to Do not disturb
        let inIt = 0;
        for (const q of presence().values()) if (q.calling?.serverId === c.serverId && q.calling.channelId === c.channelId && now() - q.lastSeen <= ONLINE_WINDOW_MS) inIt++;
        if (inIt > 1 || dnd()) continue;
      }
      const prof = profiles().get(uid);
      out.push({
        key,
        serverId: c.serverId,
        channelId: c.channelId,
        name: nameOf(uid),
        face: faceStyle(prof),
        faceText: faceText(prof, nameOf(uid)),
        line: direct ? "is calling you" : `started a call in ${sv.name} · ${c.channelName}`,
        ringing: direct && !dnd(),
      });
    }
    return out;
  });
  const [pendingAnswer, setPendingAnswer] = createSignal<{ serverId: string; channelId: string } | undefined>();
  function answerCall(c: { key: string; serverId: string; channelId: string }) {
    setDismissedCalls((prev) => new Set(prev).add(c.key));
    setDmHome(isDm(servers().find((x) => x.id === c.serverId)));
    remember(lastChannelKey(c.serverId), c.channelId);
    setServerId(c.serverId);
    setPendingAnswer({ serverId: c.serverId, channelId: c.channelId });
    setNavOpen(false);
  }
  // join once the server (and its channel) has loaded
  createEffect(() => {
    const want = pendingAnswer();
    if (!want || serverId() !== want.serverId || !channels().some((c) => c.id === want.channelId)) return;
    setPendingAnswer(undefined);
    pickChannel(want.channelId);
  });

  // Picture tiles all the way (Kaalob): # text and voice channels are no
  // longer listed (their data stays). A tile's chat lives in the right sidebar.
  const roomTiles = () => channels().filter((c) => c.kind === "room" && !hiddenFromSidebar(c));
  const chatsOf = (tileId: string) => channels().filter((c) => c.kind === "text" && c.parentId === tileId);
  // With a tile open, its chat sits in the right sidebar.
  const tileChat = createMemo(() => {
    const ch = channel();
    return ch?.kind === "room" ? chatsOf(ch.id)[0] : undefined;
  });

  return (
    <div
      class="shell"
      // the right sidebar's dragged width (Accessibility), for the layout in app.css. The left one keeps its own width (Kaalob).
      style={{ "--right-wide": access().rightWidth ? `${access().rightWidth}px` : undefined }}
      on:click={(event:MouseEvent) => {if(Date.now()<panelSwipeClickBlockedUntil){event.preventDefault();event.stopPropagation();}}}
      onTouchStart={startPanelSwipe} on:touchmove={movePanelSwipe} onTouchEnd={endPanelSwipe} onTouchCancel={() => {panelSwipe=undefined;}}
      onMouseMove={e => {
        if (TOUCH) return;
        const target = e.target instanceof Element ? e.target : undefined;
        // Coordinate-based activation preserves the wide hover zones without
        // placing an invisible click target above Activity or other controls.
        // Once open, the entire panel remains hoverable.
        // How near the screen's side edge brings a side bar in. The whole
        // height works now (Kaalob: the top part of the edge did nothing).
        // In the middle the reach is wide (144); near the top and the bottom
        // it is the edge itself (EDGE_REACH_NARROW), so the buttons in the
        // corners up there and the call's buttons down there stay easy to
        // reach without the side bar jumping in.
        const inOpeningBand = e.clientY >= window.innerHeight * 0.28 && e.clientY <= window.innerHeight * 0.80;
        const reach = inOpeningBand ? 144 : EDGE_REACH_NARROW;
        if (leftSlides() && (e.clientX <= reach || leftHover() && target?.closest(".rail, .side"))) enterLeft();
        else if (leftHover()) leaveLeft();
        if (!rightPinned() && (e.clientX >= window.innerWidth - reach || edgeHover() && target?.closest(".side-chat, .members"))) enterRight();
        else if (edgeHover()) leaveRight();
      }}
      onMouseLeave={() => { leaveLeft(); leaveRight(); }}
      classList={{ "nav-open": navOpen(), "with-side-chat": Boolean(tileChat()), "side-chat-open": sideChatOpen(), "right-open": rightOpen(), "right-pinned": rightPinned(), "right-wide": rightWide() || Boolean(access().rightWidth), sizing: Boolean(sizing()), "right-hover-only": rightMode() === "hover" && !TOUCH, "left-slide": leftSlides(), "left-open": leftSlides() && (leftHover() || Boolean(card()?.keepLeftOpen)) }}
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
              classList={{ active: !dmMode() && s.id === serverId(), "has-icon": Boolean(s.icon) }}
              title={s.name}
              aria-label={s.name}
              aria-current={!dmMode() && s.id === serverId() ? "true" : undefined}
              onClick={() => openServer(s.id)}
            >
              {/* the server's own picture or GIF (Server settings), else its initials */}
              <Show when={s.icon} fallback={initials(s.name)}>
                {(icon) => <img class="rail-icon" src={icon()} alt="" draggable={false} />}
              </Show>
              <Show when={waitingCount(s.id)}>
                <span class="rail-badge" title="People waiting to join">{waitingCount(s.id)}</span>
              </Show>
            </button>
          )}
        </For>
        <button type="button" class="rail-add" title="Find a server" aria-label="Find a server" onClick={() => setModal("find")}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="var(--green)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m15.5 15.5 5 5" />
          </svg>
        </button>
        <button type="button" class="rail-add" title="New server" aria-label="New server" onClick={() => setModal("new-server")}>
          +
        </button>
        <button type="button" class="rail-add" title="Join with an invite code" aria-label="Join with an invite code" onClick={() => setModal("join")}>
          #
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
          {/* the left side has its own pin, apart from the right one: keep it
              showing in a call, or let it slide away. Always here, so it can
              be set before the call starts. */}
          <PinButton pinned={leftPinned()} onPin={pinLeft} />
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

        <Show when={!dmMode() && server() && (server()!.announcement || runsServer())}>
          <section class="announcement" aria-label="Announcement">
            <Show
              when={editingAnnouncement()}
              fallback={
                <>
                  <Show
                    when={server()!.announcement}
                    fallback={
                      <button class="announcement-add" type="button" onClick={() => { setAnnouncementDraft(""); setEditingAnnouncement(true); }}>
                        + Add announcement
                      </button>
                    }
                  >
                    <p class="announcement-text">{linkify(server()!.announcement ?? "")}</p>
                    <Show when={runsServer()}>
                      <button
                        class="announcement-edit"
                        type="button"
                        title="Edit announcement"
                        aria-label="Edit announcement"
                        onClick={() => { setAnnouncementDraft(server()!.announcement ?? ""); setEditingAnnouncement(true); }}
                      >
                        ✎
                      </button>
                    </Show>
                  </Show>
                </>
              }
            >
              <textarea
                class="announcement-input"
                rows="4"
                maxLength={1000}
                placeholder="Write an announcement for everyone in this server"
                value={announcementDraft()}
                onInput={(e) => setAnnouncementDraft(e.currentTarget.value)}
              />
              <div class="announcement-actions">
                <button
                  class="btn primary"
                  type="button"
                  onClick={async () => {
                    await setAnnouncement(server()!.id, announcementDraft()).catch(() => {});
                    setEditingAnnouncement(false);
                  }}
                >
                  Post
                </button>
                <Show when={server()!.announcement}>
                  <button
                    class="btn"
                    type="button"
                    onClick={async () => {
                      await setAnnouncement(server()!.id, "").catch(() => {});
                      setEditingAnnouncement(false);
                    }}
                  >
                    Clear
                  </button>
                </Show>
                <button class="btn" type="button" onClick={() => setEditingAnnouncement(false)}>
                  Cancel
                </button>
              </div>
            </Show>
          </section>
        </Show>

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
          <Show when={server()} fallback={<p class="side-empty">No servers yet. Find one with the magnifier, or make your own with +.</p>}>
            {/* someone in stream mode: their LIVE tile first (Kaalob's drawing) */}
            <For each={liveStreams().filter((key) => {
              const ch = channels().find((c) => c.id === key.split("|")[1]);
              return !ch || !hiddenFromSidebar(ch);
            })}>
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
                  {/* built-in tiles (Node Lounge, Living Room) cannot be deleted */}
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
      <main
        class="main"
        onTouchStart={startCallSwipe}
        on:touchmove={moveCallSwipe}
        onTouchEnd={endCallSwipe}
        onTouchCancel={() => {callSwipe=undefined;}}
        on:dh-open-channels={() => { setSideChatOpen(false); setNavOpen(true); }}
      >
        <header class="main-head" classList={{ "in-call": inThisCall() }}>
          <Show
            when={isDm(server()) && server()}
            fallback={
              <span class="main-title">
                <Show when={channel()?.kind !== "room" && channel()?.kind !== "voice"}>
                  <span class="hash">#</span>{" "}
                </Show>
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
                  {channelId() === DM_CALL ? (
                    "Messages"
                  ) : (
                    <>
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--green)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <rect x="2.5" y="6" width="13" height="12" rx="3" />
                        <path d="m15.5 10.5 6-3.5v10l-6-3.5" />
                      </svg>{" "}
                      Call
                    </>
                  )}
                </button>
              </>
            )}
          </Show>
          <Show when={inThisCall() && roomToggle()}>
            {(toggle) => (
              <div class="pane-switch" role="group" aria-label={`${channel()?.name ?? ""} view`}>
                <div class="pane-switch-track" classList={{ "room-selected": toggle().pane() === "room" }}>
                  <button type="button" aria-pressed={toggle().pane() === "video"} onClick={() => toggle().show("video")}>
                    {toggle().labels.video}
                  </button>
                  <button type="button" aria-pressed={toggle().pane() === "room"} onClick={() => toggle().show("room")} disabled={!toggle().canRoom()}>
                    {toggle().labels.room}
                  </button>
                </div>
              </div>
            )}
          </Show>
          <Show when={inThisCall() && tvRemoteAvailable()}>
            <button
              class="btn tv-remote-btn"
              type="button"
              aria-pressed={tvRemoteOpen()}
              onClick={() => setTvRemoteOpen((v) => !v)}
            >
              TV remote
            </button>
          </Show>
          <CallPopup calls={incomingCalls()} onAnswer={answerCall} onDecline={(c) => setDismissedCalls((prev) => new Set(prev).add(c.key))} />
          <Notifications uid={props.uid} staff={props.staff} unreadInbox={unreadDms()} latestInboxAt={Math.max(0,...dms().filter(d => dmUnread(d.id)).map(d => latest().get(d.id)?.at ?? 0))} onOpen={() => openFeedback()} onItems={setNotificationItems} onError={setNotificationError} />
          {/* stats, approvals, who's online, servers, oversight, feedback, activity and the audit log in one place (staff only) */}
          <Show when={props.staff}>
            <button class="btn" type="button" title="Staff dashboard" onClick={() => openDashboard()}>
              Dashboard
            </button>
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
          <Match when={!dmMode() && !realServers().length}>
            <div class="find-empty-state">
              <h2>Find a server</h2>
              <p class="find-hint">You are not in any server yet. Search for one by name and ask to join, or make your own with +.</p>
              <Show when={serverListError()}>
                <p class="form-error" role="alert">Your servers could not be loaded ({serverListError()}). Reload the page; if this stays, tell Kaalob this code.</p>
              </Show>
              <FindServer uid={props.uid} name={nameOf(props.uid)} username={props.username} joinedIds={servers().map((x) => x.id)} />
            </div>
          </Match>
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
              server={server()}
              />
            )}
          </Match>
          <Match when={server() && channel() && UNDER_CONSTRUCTION.has(channel()!.roomKey ?? "") && channel()}>
            {(ch) => (
              <div class="main-empty">
                🚧 {ch().name} is under construction. Check back soon.
              </div>
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
                  onToggle={setRoomToggle}
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
            <Sizer side="right" />
            <header class="side-chat-head">
              <span>
                <span class="hash">#</span> {chat().name}
              </span>
              <WideButton wide={rightWide() || Boolean(access().rightWidth)} onWide={widenRight} />
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
            {/* the TV screen, above the people and the chat (Kaalob): a click lists
                the channels; with none chosen it follows this tile's Darkwood Room TV.
                Not on a Television channel: that one already has the big screen. */}
            <Show when={channel() && !isTvChannel(channel()!) ? channel()!.id : undefined}>
              {(tileId) => <SideTv serverId={server()!.id} channelId={tileId()} profiles={profiles()} room={hasDarkwoodRoom(channel()!)} />}
            </Show>
            {/* who is online stays visible with a tile open, above its chat */}
            <div class="side-online">
              <MemberGroup
                server={server()}
                label={`Online — ${onlineHere().length}`}
                uids={onlineHere()}
                profiles={profiles()}
                nameOf={nameOf}
                whereOf={whereOf}
                online
                onPick={openCard}
              />
              {/* the People tab lists everyone in the server: offline members under the online ones (Kaalob) */}
              <MemberGroup
                server={server()}
                label={`Offline — ${offlineHere().length}`}
                uids={offlineHere()}
                profiles={profiles()}
                nameOf={nameOf}
                onPick={openCard}
              />
              {/* + People sits under the people, not above them (Kaalob) */}
              <Show when={runsServer()}>
                <button class="side-tool people-btn" type="button" onClick={() => setModal("people")}>
                  + People
                </button>
              </Show>
            </div>
            <Chat
              serverId={server()!.id}
              channel={chat()}
              uid={props.uid}
              profiles={profiles()}
              canModerate={runsServer()}
              emojis={emojis()}
              members={server()?.memberUids}
              server={server()}
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
        <Sizer side="right" />
        <div class="members-head">
          <WideButton wide={rightWide() || Boolean(access().rightWidth)} onWide={widenRight} />
          <PinButton pinned={rightPinned()} onPin={pinRight} />
        </div>
        <Show when={server()}>
          {(s) => {
            const online = () => s().memberUids.filter(isOnline);
            const offline = () => s().memberUids.filter((u) => !isOnline(u));
            return (
              <>
                <MemberGroup
                server={server()}
                  label={`Online — ${online().length}`}
                  uids={online()}
                  profiles={profiles()}
                  nameOf={nameOf}
                  whereOf={whereOf}
                  online
                  onPick={openCard}
                />
                <MemberGroup
                server={server()}
                  label={`Offline — ${offline().length}`}
                  uids={offline()}
                  profiles={profiles()}
                  nameOf={nameOf}
                  onPick={openCard}
                />
                <Show when={runsServer()}>
                  <button class="side-tool people-btn" type="button" onClick={() => setModal("people")}>
                    + People
                  </button>
                </Show>
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
      <FindServerDialog
        open={modal() === "find"}
        uid={props.uid}
        name={nameOf(props.uid)}
        username={props.username}
        joinedIds={servers().map((x) => x.id)}
        onClose={() => setModal("")}
      />
      <JoinServerDialog
        open={modal() === "join"}
        servers={servers()}
        uid={props.uid}
        onOpen={openServer}
        onJoined={setPendingJoin}
        onClose={() => setModal("")}
      />
      {/* everything about this one server: its own window, the gear by its name (ServerSettings.tsx) */}
      <ServerSettings
        open={modal() === "rename" || modal() === "people"}
        startOn={modal() === "people" ? "members" : "profile"}
        onClose={() => setModal("")}
        server={server()}
        channels={channels()}
        emojis={emojis()}
        profiles={profiles()}
        uid={props.uid}
        // the owner may delete a server, never the home server (its first Node Lounge tile)
        canDelete={Boolean(server() && server()!.ownerUid === props.uid && !isHomeServer(server(), channels()))}
        onNewChannel={() => setModal("new-channel")}
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
        notifications={<NotificationList items={notificationItems()} error={notificationError()} unreadInbox={unreadDms()} onInbox={() => {setFeedbackOpen(false);goDms();}} onFeedback={tab => tab === "inbox" ? (setFeedbackOpen(false), openDashboard("insights", "feedback")) : setFeedbackTab(tab)} />}
        onClose={() => setFeedbackOpen(false)}
        uid={props.uid}
        name={nameOf(props.uid)}
        username={props.username}
        where={
          feedbackWhere() ||
          [server()?.name, channel() ? `${channel()!.kind === "room" ? "tile" : "#"} ${channel()!.name}` : ""].filter(Boolean).join(" · ") ||
          "Darkwood Node"
        }
      />
      <Show when={customizeOpen()}><Customize uid={props.uid} profile={profiles().get(props.uid)} name={nameOf(props.uid)} onClose={() => setCustomizeOpen(false)} /></Show>
      <DashboardDialog
        open={dashboardOpen()}
        onClose={() => setDashboardOpen(false)}
        profiles={profiles()}
        uid={props.uid}
        name={nameOf(props.uid)}
        username={props.username}
        owner={isOwnerAccount()}
        initialPage={dashboardPage()}
        focusSection={dashboardFocus()}
        onMessage={dashboardMessage}
      />
      {/* Settings: one window, its sections down the left (Settings.tsx) */}
      <Settings
        open={modal() === "me"}
        onClose={() => setModal("")}
        name={nameOf(props.uid)}
        username={props.username}
        uid={props.uid}
        profile={profiles().get(props.uid)}
        sidebarMode={leftMode() === rightMode() ? leftMode() : undefined}
        onSidebarMode={chooseSidebarMode}
        onProfile={() => {
          setModal("");
          setCustomizeOpen(true);
        }}
        onLogout={props.onLogout}
      />
    </div>
  );
}

/** Make the right sidebar bigger toward the left (a third of the screen), or its normal size again. */
function WideButton(props: { wide: boolean; onWide: (on: boolean) => void }) {
  const label = () => (props.wide ? "Make the sidebar its normal size" : "Make the sidebar bigger (a third of the screen)");
  return (
    <button type="button" class="icon-btn wide-btn" classList={{ on: props.wide }} aria-pressed={props.wide} title={label()} aria-label={label()} onClick={() => props.onWide(!props.wide)}>
      {/* an arrow toward the edge it will move to: left to grow, right to shrink */}
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <Show when={props.wide} fallback={<path d="M4 4v16M20 12H9M13 7l-5 5 5 5" />}>
          <path d="M20 4v16M4 12h11M11 7l5 5-5 5" />
        </Show>
      </svg>
    </button>
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
  // the app shell is CSS-zoomed on desktop (.shell { zoom: 1.15 }): every pixel value
  // given to this card is scaled by it, so work in zoomed units
  const [zoom, setZoom] = createSignal(1);
  const vw = () => viewport().width / zoom();
  const vh = () => viewport().height / zoom();
  const width = () => Math.min(340, vw() - 24);
  const px = () => props.x / zoom();
  const opensLeft = () => px() >= width() + 24;
  const left = () => {
    const preferred = opensLeft() ? px() - width() - 12 : (props.anchorRight ?? props.x) / zoom() + 12;
    return Math.max(12, Math.min(preferred, vw() - width() - 12));
  };
  const top = () => Math.max(12, Math.min(props.y / zoom(), vh() - height() - 12));
  onMount(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel?.focus();
    const resize = () => setViewport({
      width: window.innerWidth,
      height: Math.min(window.innerHeight, window.visualViewport?.height ?? window.innerHeight, document.documentElement.clientHeight || window.innerHeight),
    });
    resize();
    const zoomOf = () => {
      const shell = panel?.closest(".shell");
      const z = shell ? parseFloat(getComputedStyle(shell).zoom) : 1;
      return Number.isFinite(z) && z > 0 ? z : 1;
    };
    setZoom(zoomOf());
    const measure = () => { if (panel) { setZoom(zoomOf()); setHeight(panel.offsetHeight); } };
    const observer = new ResizeObserver(measure);
    if (panel) {
      observer.observe(panel);
      // content (status rows, pictures) can settle after the first paint: re-measure a few times
      measure();
      requestAnimationFrame(measure);
      for (const ms of [100, 300, 800]) setTimeout(measure, ms);
      panel.addEventListener("animationend", measure);
    }
    const visual = window.visualViewport;
    visual?.addEventListener("resize", resize);
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
    onCleanup(() => { observer.disconnect(); window.removeEventListener("keydown", onKey); window.removeEventListener("resize", resize); visual?.removeEventListener("resize", resize); previous?.focus(); });
  });
  return (
    <div class="card-backdrop" onClick={props.onClose}>
      <article
        ref={panel} role="dialog" aria-modal="true" tabIndex={-1}
        class={`profile-card profile-effect-${customization(props.profile?.customization).effect}`}
        style={{
          "--profile-enter-x": opensLeft() ? "28px" : "-28px",
          width: `${width()}px`,
          "max-height": `${vh() - 24}px`,
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
  /** the server, for its roles: a person's name takes the color of their top role */
  server?: Server;
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
              <span class="member-name" style={topRoleOf(props.server, uid) ? { color: topRoleOf(props.server, uid)!.color } : undefined} title={topRoleOf(props.server, uid)?.name}>
                {props.nameOf(uid)}<DeveloperBadge username={props.profiles.get(uid)?.username} />
              </span>
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

/** What + Channel can make. Every one is a picture tile with its own chat. */
type NewTile = "video" | "tv" | "link";
const NEW_TILES: { id: NewTile; label: string; text: string; image: string }[] = [
  { id: "video", label: "Videochat", text: "Everyone's webcams together, with a chat.", image: VIDEOCHAT_TILE_IMAGE },
  { id: "tv", label: "Television", text: "A big TV to watch a Stream together, like Living Room.", image: TV_TILE_IMAGE },
  { id: "link", label: "Room link", text: "A videochat with a page (a game, a site) on its Room side.", image: "/link-tile.svg" },
];

function NewChannelDialog(props: {
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string, extra: { image: string; url?: string; tv?: true }) => Promise<unknown>;
}) {
  // Picture tiles all the way: a new channel is a tile. Which kind is picked here.
  const [kind, setKind] = createSignal<NewTile>("video");
  const [image, setImage] = createSignal("");
  const [error, setError] = createSignal("");
  const picked = () => NEW_TILES.find((t) => t.id === kind())!;

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
    setKind("video");
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
          // no picture chosen: the kind's own picture
          const extra: { image: string; url?: string; tv?: true } = { image: image() || picked().image };
          if (kind() === "tv") extra.tv = true;
          if (kind() === "link") {
            const url = String(form.get("url") ?? "").trim();
            if (!/^https?:\/\//i.test(url)) return setError("Use a full link, starting with https://");
            extra.url = url;
          }
          try {
            await props.onSubmit(name, extra);
            close();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not create that.");
          }
        }}
      >
        <fieldset class="channel-kinds">
          <legend>What kind of channel?</legend>
          <For each={NEW_TILES}>
            {(t) => (
              <label class="channel-kind">
                <input type="radio" name="tile-kind" checked={kind() === t.id} onChange={() => { setKind(t.id); setError(""); }} />
                <img src={imageSrc(t.image)} alt="" draggable={false} />
                <b>{t.label}</b>
                <small>{t.text}</small>
              </label>
            )}
          </For>
        </fieldset>
        <label class="field">
          <span>Channel name</span>
          <input name="name" maxLength={40} required />
        </label>
        <Show when={kind() === "link"}>
          <label class="field">
            <span>Room link</span>
            <input name="url" type="url" placeholder="https://" />
          </label>
        </Show>
        <label class="field">
          <span>Picture (you can skip this)</span>
          <input type="file" accept="image/*" onChange={pickImage} />
        </label>
        <img class="tile-preview" src={image() || imageSrc(picked().image)} alt="" />
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

function explain(err: unknown, fallback: string) {
  const message = err instanceof Error ? err.message : "";
  if (/permission|insufficient/i.test(message)) return "That was refused. An approved member can use a code the server still has.";
  return message || fallback;
}

/** Enter an invite code and join that server. */
function JoinServerDialog(props: {
  open: boolean;
  servers: Server[];
  uid: string;
  onOpen: (id: string) => void;
  onJoined: (id: string) => void;
  onClose: () => void;
}) {
  const [error, setError] = createSignal("");
  const [joining, setJoining] = createSignal(false);
  const close = () => {
    setError("");
    props.onClose();
  };
  return (
    <Modal title="Join a server" open={props.open} onClose={close}>
      <form
        class="modal-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const raw = String(new FormData(e.currentTarget).get("code") ?? "");
          setJoining(true);
          setError("");
          try {
            const { serverId, code } = await lookupInvite(raw);
            if (props.servers.some((s) => s.id === serverId)) props.onOpen(serverId);
            else {
              await redeemInvite(props.uid, serverId, code);
              props.onJoined(serverId);
            }
            close();
          } catch (err) {
            setError(explain(err, "Could not join with that code."));
          } finally {
            setJoining(false);
          }
        }}
      >
        <p class="modal-text">Ask the server’s owner for the code in Server settings. Your account still has to be approved.</p>
        <label class="field">
          <span>Invite code</span>
          <input name="code" class="invite-input" maxLength={16} autocapitalize="characters" autocomplete="off" required />
        </label>
        <Show when={error()}>
          <p class="form-error">{error()}</p>
        </Show>
        <div class="modal-actions">
          <button class="btn" type="button" onClick={close}>
            Cancel
          </button>
          <button class="btn primary" type="submit" disabled={joining()}>
            {joining() ? "Joining…" : "Join"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** The code for this server. Creating a new one replaces the old one. */
export function InviteCodeField(props: { server?: Server }) {
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [copied, setCopied] = createSignal(false);

  async function mint() {
    if (!props.server) return;
    setBusy(true);
    setError("");
    try {
      await setInviteCode(props.server.id);
    } catch (err) {
      setError(explain(err, "Could not make a code."));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    const code = props.server?.inviteCode;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Could not copy. Select the code and copy it.");
    }
  }

  return (
    <div class="field">
      <span>Invite code</span>
      <div class="invite-row">
        <code class="invite-code">{props.server?.inviteCode ?? "No code yet"}</code>
        <button class="btn" type="button" disabled={!props.server?.inviteCode} onClick={() => void copy()}>
          {copied() ? "Copied" : "Copy"}
        </button>
        <button class="btn" type="button" disabled={busy() || !props.server} onClick={() => void mint()}>
          {busy() ? "Working…" : props.server?.inviteCode ? "New code" : "Create code"}
        </button>
      </div>
      <small class="field-hint">An approved member enters this on the # button to join. A new code replaces the old one.</small>
      <Show when={error()}>
        <p class="form-error">{error()}</p>
      </Show>
    </div>
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
