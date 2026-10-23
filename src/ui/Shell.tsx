import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import {
  type Channel,
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
  watchPresence,
  watchProfiles,
  watchServers,
} from "../data/store";
import { Chat } from "./Chat";
import { Modal } from "./Modal";
import { RoomPane } from "./RoomPane";
import { VoiceRoom } from "./VoiceRoom";
import { whereNow } from "../data/where";

import "./app.css";

const LAST_SERVER_KEY = "dh_last_server";
const lastChannelKey = (sid: string) => `dh_last_channel_${sid}`;
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

  const isOnline = (uid: string) => now() - (presence().get(uid)?.lastSeen ?? 0) < ONLINE_WINDOW_MS;
  // where an online person is; a place older than the window has expired
  const whereOf = (uid: string) => {
    const p = presence().get(uid);
    return p?.where && now() - p.whereAt < ONLINE_WINDOW_MS ? p.where : "";
  };
  const onlineHere = () => server()?.memberUids.filter(isOnline) ?? [];
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
      classList={{ "nav-open": navOpen(), "with-side-chat": Boolean(tileChat()), "side-chat-open": sideChatOpen(), "right-open": rightOpen() }}
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
                  </button>
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
          <span class="avatar" style={{ background: profiles().get(props.uid)?.color ?? "#4ADE80" }}>
            {initials(props.name)}
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
  const color = () => props.profile?.color ?? "#404040";
  return (
    <div class="card-backdrop" onClick={props.onClose}>
      <article
        class="profile-card"
        style={{ left: `${left()}px`, top: `${top()}px` }}
        onClick={(e) => e.stopPropagation()}
        aria-label={`${props.name}'s profile`}
      >
        <div class="profile-banner" style={{ background: color() }} />
        <span class="avatar profile-avatar" style={{ background: color() }}>
          {initials(props.name)}
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
            <span class="avatar small" style={{ background: props.profiles.get(uid)?.color ?? "#404040" }}>
              {initials(props.nameOf(uid))}
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
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      setError("");
      setBanner(await shrinkImage(file, 960));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that image");
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
              {shown() ? "Change picture" : "Upload picture"}
              <input type="file" accept="image/*" onChange={pick} />
            </label>
            <Show when={shown()}>
              <button class="btn danger" type="button" onClick={() => setBanner(null)}>
                Remove
              </button>
            </Show>
          </div>
          <small class="field-hint">Wide pictures work best (about 3 : 1).</small>
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
              <span class="avatar small" style={{ background: p.color }}>
                {initials(p.name || p.username)}
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
