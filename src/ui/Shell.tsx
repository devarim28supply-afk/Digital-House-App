import { For, type JSX, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import {
  type Channel,
  type Emoji,
  ONLINE_WINDOW_MS,
  type Presence,
  type Profile,
  type ProfilePicture,
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
  saveCallName,
  setTileImage,
  saveProfilePicture,
  watchEmojis,
  watchPresence,
  watchProfiles,
  watchServers,
} from "../data/store";
import { uploadPicture } from "../data/files";
import { Chat } from "./Chat";
import { Modal } from "./Modal";
import { RoomPane } from "./RoomPane";
import { VoiceRoom } from "./VoiceRoom";
import { setWatchRequest, streamingIn, whereNow } from "../data/where";
import { LiveTile } from "./LiveTile";

import "./app.css";

const LAST_SERVER_KEY = "dh_last_server";
const lastChannelKey = (sid: string) => `dh_last_channel_${sid}`;
const RIGHT_MODE_KEY = "dh_right_mode";
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
  return profile?.photo
    ? { "background-color": color, "background-image": `url("${profile.photo}")`, "background-size": "cover", "background-position": "center" }
    : { background: color };
}
/** The initials inside it, only when there is no picture. */
export const faceText = (profile: Profile | undefined, name: string) => (profile?.photo ? "" : initials(name));
/** The card's top strip or its background: the chosen picture over your colour. */
function pictureStyle(profile: Profile | undefined, field: "banner" | "background"): JSX.CSSProperties {
  const url = profile?.[field];
  const color = profile?.color ?? "#404040";
  return url
    ? { "background-color": color, "background-image": `url("${url}")`, "background-size": "cover", "background-position": "center" }
    : { background: color };
}

/**
 * Darkwood Node once you are in: servers on the far left, the chosen
 * server's channels next to them, the channel in the middle, and who is in
 * the server on the right. On a phone the two left columns slide in.
 */
export function Shell(props: { uid: string; admin: boolean; name: string; username: string; onLogout: () => void }) {
  const [servers, setServers] = createSignal<Server[]>([]);
  const [profiles, setProfiles] = createSignal(new Map<string, Profile>());
  const [presence, setPresence] = createSignal(new Map<string, Presence>());
  const [now, setNow] = createSignal(Date.now());
  const [serverId, setServerId] = createSignal<string | undefined>(recall(LAST_SERVER_KEY));
  const [channels, setChannels] = createSignal<Channel[]>([]);
  const [channelId, setChannelId] = createSignal<string | undefined>();
  const [navOpen, setNavOpen] = createSignal(false);
  const [sideChatOpen, setSideChatOpen] = createSignal(false);
  const [modal, setModal] = createSignal<"" | "new-server" | "rename" | "people" | "new-channel" | "me">("");
  // Your one videochat, like Discord voice: opening a room tile or voice
  // channel joins it, and it stays connected while you read other channels
  // (or servers) until Disconnect. Joining another one moves you there.
  const [call, setCall] = createSignal<{ serverId: string; channel: Channel } | undefined>();
  function joinCall(serverId: string, ch: Channel) {
    if (call()?.channel.id === ch.id) return;
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
    // the operator gets the home server made on first sign-in
    if (props.admin) void ensureHomeServer(props.uid).catch(() => {});
    // everyone who got in through M2A-access is in every open server
    void joinOpenServers(props.uid).catch(() => {});
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

  // Keep a valid server picked.
  createEffect(() => {
    const list = servers();
    if (!list.length) return;
    if (!list.some((s) => s.id === serverId())) setServerId(list[0].id);
  });

  const server = createMemo(() => servers().find((s) => s.id === serverId()));
  const runsServer = () => Boolean(server() && (server()!.ownerUid === props.uid || props.admin));

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
        // made before servers could be open: the home server is open to all
        // who get in (an explicit "closed" in Server settings is respected)
        if (s.open === undefined) void setServerOpen(sid, true).catch(() => {});
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
  const inThisCall = () => Boolean(channel() && call()?.channel.id === channel()!.id);

  // The right sidebar slides out of the way. A new chat message slides it in
  // for 30 seconds (each message restarts the 30); the cursor at the right
  // edge of the screen slides it in while it is there.
  const [edgeHover, setEdgeHover] = createSignal(false);
  // Leaving it, it stays 5 more seconds (Kaalob); coming back cancels that.
  let leaveTimer = 0;
  function enterRight() {
    window.clearTimeout(leaveTimer);
    setEdgeHover(true);
  }
  function leaveRight() {
    window.clearTimeout(leaveTimer);
    leaveTimer = window.setTimeout(() => setEdgeHover(false), RIGHT_LINGER_MS);
  }
  onCleanup(() => window.clearTimeout(leaveTimer));
  const [chatPing, setChatPing] = createSignal(false);
  let pingTimer = 0;
  function pingRight() {
    setChatPing(true);
    window.clearTimeout(pingTimer);
    pingTimer = window.setTimeout(() => setChatPing(false), RIGHT_HOLD_MS);
  }
  onCleanup(() => window.clearTimeout(pingTimer));

  // A person's profile card, like Discord's, next to where you clicked.
  const [card, setCard] = createSignal<{ uid: string; x: number; y: number } | undefined>();
  const openCard = (uid: string, at: MouseEvent) => setCard({ uid, x: at.clientX, y: at.clientY });
  // A profile card opened from the sidebar keeps the sidebar in until it closes.
  // A file dragged in from a folder slides it in too, so it can be dropped on the chat.
  const [fileDrag, setFileDrag] = createSignal(false);
  const rightOpen = () => edgeHover() || chatPing() || sideChatOpen() || Boolean(card()) || fileDrag();
  // Each person picks: the sidebar slides in and out, or it is always there
  // as its own column beside the videochat (covering nothing). Remembered.
  const [rightPinned, setRightPinned] = createSignal(recall(RIGHT_MODE_KEY) === "pinned");
  function pinRight(on: boolean) {
    setRightPinned(on);
    remember(RIGHT_MODE_KEY, on ? "pinned" : "slide");
  }

  const isOnline = (uid: string) => now() - (presence().get(uid)?.lastSeen ?? 0) < ONLINE_WINDOW_MS;
  // where an online person is; a place older than the window has expired
  const whereOf = (uid: string) => {
    const p = presence().get(uid);
    return p?.where && now() - p.whereAt < ONLINE_WINDOW_MS ? p.where : "";
  };
  const onlineHere = () => server()?.memberUids.filter(isOnline) ?? [];
  // Who is streaming in this server right now (stream mode): their LIVE tiles.
  // Kept as plain text keys ("uid|channel"): a key stays the same string while
  // the stream goes on, so its LIVE tile stays put. Rebuilt objects would make
  // the list throw the tile away (and reconnect it) on every presence beat.
  const liveStreams = createMemo(
    () =>
      onlineHere().flatMap((uid) => {
        const live = presence().get(uid)?.streaming;
        const ch = live && live.serverId === serverId() ? channels().find((c) => c.id === live.channelId) : undefined;
        return ch ? [`${uid}|${ch.id}`] : [];
      }),
    [],
    { equals: (a, b) => a.length === b.length && a.every((k, i) => k === b[i]) },
  );
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
  const nameOf = (uid: string) => profiles().get(uid)?.name || profiles().get(uid)?.username || "Member";

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
      classList={{ "nav-open": navOpen(), "with-side-chat": Boolean(tileChat()), "side-chat-open": sideChatOpen(), "right-open": rightOpen(), "right-pinned": rightPinned() }}
    >
      {/* ---- servers ---- */}
      <nav class="rail" aria-label="Servers">
        <For each={servers()}>
          {(s) => (
            <button
              type="button"
              class="rail-server"
              classList={{ active: s.id === serverId() }}
              title={s.name}
              aria-label={s.name}
              aria-current={s.id === serverId() ? "true" : undefined}
              onClick={() => setServerId(s.id)}
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
      <aside class="side">
        {/* the banner on its own, the name in the row under it */}
        <Show when={server()?.banner}>
          {(banner) => <img class="side-banner" src={banner()} alt="" draggable={false} />}
        </Show>
        <header class="side-head">
          <span class="side-title">{server()?.name ?? "Darkwood Node"}</span>
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
          <Show when={server()} fallback={<p class="side-empty">No servers yet. Make one with +, or wait to be added.</p>}>
            {/* someone in stream mode: their LIVE tile first (Kaalob's drawing) */}
            <For each={liveStreams()}>
              {(key) => {
                const [uid, channelId] = key.split("|");
                return (
                  <div class="tile-row">
                    <LiveTile
                      serverId={serverId()!}
                      channelId={channelId}
                      uid={uid}
                      name={nameOf(uid)}
                      frozen={call()?.serverId === serverId() && call()?.channel.id === channelId}
                      onOpen={() => {
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
                            await setTileImage(serverId()!, c.id, await shrinkImage(file, 480));
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
        <footer class="me">
          <span class="avatar" style={faceStyle(profiles().get(props.uid), "#4ADE80")}>
            {faceText(profiles().get(props.uid), props.name)}
          </span>
          <span class="me-names">
            <b>{props.name}</b>
            <small>@{props.username || "member"}</small>
          </span>
          <button class="icon-btn" type="button" title="Account" aria-label="Account" onClick={() => setModal("me")}>
            ⚙
          </button>
        </footer>
      </aside>

      <div class="scrim" onClick={() => setNavOpen(false)} />

      {/* ---- the channel ---- */}
      <main class="main">
        <header class="main-head">
          <button class="icon-btn menu-btn" type="button" aria-label="Channels" onClick={() => setNavOpen(true)}>
            ☰
          </button>
          <span class="main-title">
            <span class="hash">{channel()?.kind === "room" ? "▣" : channel()?.kind === "voice" ? "◉" : "#"}</span>{" "}
            {channel()?.name ?? ""}
          </span>
          <Show when={tileChat()}>
            {(chat) => (
              <button
                class="btn side-chat-btn"
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
          <Match when={server() && channel()?.kind === "text" && channel()}>
            {(ch) => (
              <Chat
                serverId={server()!.id}
                channel={ch()}
                uid={props.uid}
                profiles={profiles()}
                canModerate={runsServer()}
              emojis={emojis()}
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
                  name={props.name}
                  username={props.username}
                  profiles={profiles()}
                  onLeave={() => setCall(undefined)}
                />
              ) : (
                <VoiceRoom
                  serverId={c.serverId}
                  channel={c.channel}
                  uid={props.uid}
                  name={props.name}
                  profiles={profiles()}
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
      <div class="right-edge" aria-hidden="true" onMouseEnter={enterRight} />
      <Show when={server() && tileChat()}>
        {(chat) => (
          <aside
            class="side-chat"
            aria-label={`# ${chat().name}`}
            onMouseEnter={enterRight}
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
        onMouseEnter={enterRight}
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
            profile={profiles().get(c().uid)}
            name={nameOf(c().uid)}
            online={isOnline(c().uid)}
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
      <Modal title="Account" open={modal() === "me"} onClose={() => setModal("")}>
        <p class="modal-text">
          Signed in as <b>{props.name}</b> (@{props.username || "member"}).
        </p>
        <PictureField
          uid={props.uid}
          field="photo"
          label="Profile picture"
          hint="The round picture on your card, in chat and on your tile. A GIF keeps moving."
          value={profiles().get(props.uid)?.photo}
          preview={
            <span class="avatar photo-preview" style={faceStyle(profiles().get(props.uid))}>
              {faceText(profiles().get(props.uid), props.name)}
            </span>
          }
        />
        <PictureField
          uid={props.uid}
          field="banner"
          label="Card banner"
          hint="The strip across the top of your card. A GIF keeps moving."
          value={profiles().get(props.uid)?.banner}
          preview={<span class="picture-preview" style={pictureStyle(profiles().get(props.uid), "banner")} />}
        />
        <PictureField
          uid={props.uid}
          field="background"
          label="Card background"
          hint="Fills the card behind your name. A GIF keeps moving."
          value={profiles().get(props.uid)?.background}
          preview={<span class="picture-preview" style={pictureStyle(profiles().get(props.uid), "background")} />}
        />
        <CallNameField uid={props.uid} name={props.name} current={profiles().get(props.uid)?.callName ?? ""} />
        <div class="field">
          <span>Right sidebar</span>
          <div class="kind-pick">
            <label>
              <input type="radio" name="right-mode" checked={!rightPinned()} onChange={() => pinRight(false)} /> Slides in
              and out
            </label>
            <label>
              <input type="radio" name="right-mode" checked={rightPinned()} onChange={() => pinRight(true)} /> Always
              show (beside, covering nothing)
            </label>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn danger" type="button" onClick={props.onLogout}>
            Log out
          </button>
        </div>
      </Modal>
    </div>
  );
}

/**
 * One picture on your profile card: your round face, the strip across the
 * top, or the card itself. A GIF goes up whole and keeps moving.
 */
function PictureField(props: {
  uid: string;
  field: ProfilePicture;
  label: string;
  hint: string;
  value?: string;
  /** what that spot of the card looks like now */
  preview: JSX.Element;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  let picker: HTMLInputElement | undefined;
  async function choose(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      await saveProfilePicture(props.uid, props.field, await uploadPicture(file, { kind: "profile", name: props.field }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not use that picture");
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await saveProfilePicture(props.uid, props.field, null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove that picture");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="field photo-field">
      <span>{props.label}</span>
      <div class="photo-row">
        {props.preview}
        <input
          ref={picker}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            void choose(e.currentTarget.files?.[0]);
            e.currentTarget.value = "";
          }}
        />
        <button class="btn" type="button" disabled={busy()} onClick={() => picker?.click()}>
          {busy() ? "Saving…" : props.value ? "Change picture" : "Upload picture"}
        </button>
        <Show when={props.value}>
          <button class="btn" type="button" disabled={busy()} onClick={() => void remove()}>
            Remove
          </button>
        </Show>
      </div>
      <small class="field-hint">{props.hint}</small>
      <Show when={error()}>
        <p class="form-error">{error()}</p>
      </Show>
    </div>
  );
}

/**
 * The name on your own videochat tile, if you want it different from your
 * name (everyone sees it there). Empty = your normal name.
 */
function CallNameField(props: { uid: string; name: string; current: string }) {
  const [value, setValue] = createSignal(props.current);
  const [state, setState] = createSignal<"" | "saving" | "saved" | "error">("");
  createEffect(() => setValue(props.current));
  async function save(e: SubmitEvent) {
    e.preventDefault();
    setState("saving");
    try {
      await saveCallName(props.uid, value());
      setState("saved");
    } catch {
      setState("error");
    }
  }
  return (
    <form class="field call-name" onSubmit={save}>
      <span>Name on my webcam (videochat)</span>
      <div class="call-name-row">
        <input
          value={value()}
          maxLength={40}
          placeholder={props.name}
          onInput={(e) => {
            setValue(e.currentTarget.value);
            setState("");
          }}
        />
        <button class="btn" type="submit" disabled={state() === "saving" || value().trim() === props.current}>
          Save
        </button>
      </div>
      <small class="call-name-note">
        {state() === "saved"
          ? "Saved. Everyone sees it on your tile."
          : state() === "error"
            ? "Could not save. Check your connection."
            : "Leave it empty to show your name."}
      </small>
    </form>
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
function ProfileCard(props: {
  uid: string;
  x: number;
  y: number;
  profile?: Profile;
  name: string;
  online: boolean;
  where: string;
  owner: boolean;
  onClose: () => void;
}) {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });
  // keep the whole card on screen, beside the click
  const W = 300;
  const H = 280;
  const left = () => Math.max(12, Math.min(props.x - W - 16, window.innerWidth - W - 12));
  const top = () => Math.max(12, Math.min(props.y - 40, window.innerHeight - H - 12));
  return (
    <div class="card-backdrop" onClick={props.onClose}>
      <article
        class="profile-card"
        style={{
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
        <span class="avatar profile-avatar" style={faceStyle(props.profile)}>
          {faceText(props.profile, props.name)}
          <i class="dot" classList={{ off: !props.online }} />
        </span>
        <div class="profile-body">
          <h3>
            {props.name}
            <Show when={props.owner}>
              <span class="profile-badge">Owner</span>
            </Show>
          </h3>
          <p class="profile-user">@{props.profile?.username || "member"}</p>
          <div class="profile-section">
            <span class="group-label">Status</span>
            <p>{props.online ? props.where || "Online" : "Offline"}</p>
          </div>
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
            class="member"
            classList={{ offline: !props.online }}
            onClick={(e) => props.onPick?.(uid, e)}
          >
            <span class="avatar small" style={faceStyle(props.profiles.get(uid))}>
              {faceText(props.profiles.get(uid), props.nameOf(uid))}
              <Show when={props.online}>
                <i class="dot" />
              </Show>
            </span>
            <span class="member-text">
              <span class="member-name">{props.nameOf(uid)}</span>
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
    [...props.profiles.values()].sort((a, b) => (a.name || a.username).localeCompare(b.name || b.username));
  const inServer = (uid: string) => Boolean(props.server?.memberUids.includes(uid));
  return (
    <Modal title="People in this server" open={props.open} onClose={props.onClose}>
      <p class="modal-text">Everyone here is an approved member. Add them to let them see this server.</p>
      <div class="people-list">
        <For each={everyone()}>
          {(p) => (
            <div class="person">
              <span class="avatar small" style={faceStyle(p)}>
                {faceText(p, p.name || p.username)}
              </span>
              <span class="member-name">
                {p.name} <small>@{p.username}</small>
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
