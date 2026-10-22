import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import {
  type Channel,
  ONLINE_WINDOW_MS,
  type Profile,
  type Server,
  addServerMembers,
  createChannel,
  createRoomTile,
  createServer,
  deleteRoomTile,
  deleteChannel,
  ensureHomeServer,
  ensureLivingTile,
  removeServerMember,
  renameServer,
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

import "./app.css";

const LAST_SERVER_KEY = "dh_last_server";
const lastChannelKey = (sid: string) => `dh_last_channel_${sid}`;

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
 * Digital House once you are in: servers on the far left, the chosen
 * server's channels next to them, the channel in the middle, and who is in
 * the server on the right. On a phone the two left columns slide in.
 */
export function Shell(props: { uid: string; admin: boolean; name: string; username: string; onLogout: () => void }) {
  const [servers, setServers] = createSignal<Server[]>([]);
  const [profiles, setProfiles] = createSignal(new Map<string, Profile>());
  const [lastSeen, setLastSeen] = createSignal(new Map<string, number>());
  const [now, setNow] = createSignal(Date.now());
  const [serverId, setServerId] = createSignal<string | undefined>(recall(LAST_SERVER_KEY));
  const [channels, setChannels] = createSignal<Channel[]>([]);
  const [channelId, setChannelId] = createSignal<string | undefined>();
  const [navOpen, setNavOpen] = createSignal(false);
  const [sideChatOpen, setSideChatOpen] = createSignal(false);
  const [modal, setModal] = createSignal<"" | "new-server" | "rename" | "people" | "new-channel" | "me">("");

  onMount(() => {
    void saveProfile(props.uid, props.name, props.username);
    // the operator gets the home server made on first sign-in
    if (props.admin) void ensureHomeServer(props.uid).catch(() => {});
    const stops = [
      startPresence(props.uid),
      watchServers(props.uid, setServers),
      watchProfiles(setProfiles),
      watchPresence(setLastSeen),
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
      // the home server's Living tile, added once for servers made before tiles
      const s = servers().find((x) => x.id === sid);
      if (!tileChecked && s?.name === "Digital House" && s.ownerUid === props.uid) {
        tileChecked = true;
        void ensureLivingTile(sid, list).catch(() => {});
      }
      const current = channelId();
      if (current && list.some((c) => c.id === current)) return;
      const saved = recall(lastChannelKey(sid));
      const pick = list.find((c) => c.id === saved) ?? list.find((c) => c.kind === "text") ?? list[0];
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
  }

  const isOnline = (uid: string) => now() - (lastSeen().get(uid) ?? 0) < ONLINE_WINDOW_MS;
  const nameOf = (uid: string) => profiles().get(uid)?.name || profiles().get(uid)?.username || "Member";

  const roomTiles = () => channels().filter((c) => c.kind === "room");
  // a tile's own chat is listed under its picture, not with the other text channels
  const textChannels = () => channels().filter((c) => c.kind === "text" && !c.parentId);
  const voiceChannels = () => channels().filter((c) => c.kind === "voice");
  const chatsOf = (tileId: string) => channels().filter((c) => c.kind === "text" && c.parentId === tileId);
  // With a tile open, its chat sits in the right sidebar.
  const tileChat = createMemo(() => {
    const ch = channel();
    return ch?.kind === "room" ? chatsOf(ch.id)[0] : undefined;
  });

  return (
    <div class="shell" classList={{ "nav-open": navOpen(), "with-side-chat": Boolean(tileChat()), "side-chat-open": sideChatOpen() }}>
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
        <header class="side-head">
          <span class="side-title">{server()?.name ?? "Digital House"}</span>
          <Show when={runsServer()}>
            <button class="icon-btn" type="button" title="Rename server" aria-label="Rename server" onClick={() => setModal("rename")}>
              ✎
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
                    <img src={c.image} alt="" draggable={false} />
                    <span class="room-tile-name">{c.name}</span>
                  </button>
                  <Show when={runsServer()}>
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
                  <ChannelGroup
                    channels={chatsOf(c.id)}
                    activeId={channelId()}
                    onPick={pickChannel}
                    canEdit={false}
                    onDelete={() => {}}
                  />
                </div>
              )}
            </For>
            <ChannelGroup
              label="Text"
              channels={textChannels()}
              activeId={channelId()}
              onPick={pickChannel}
              canEdit={runsServer()}
              onDelete={(id) => void deleteChannel(serverId()!, id)}
            />
            <ChannelGroup
              label="Voice"
              channels={voiceChannels()}
              activeId={channelId()}
              onPick={pickChannel}
              canEdit={runsServer()}
              onDelete={(id) => void deleteChannel(serverId()!, id)}
            />
            <Show when={runsServer()}>
              <div class="side-tools">
                <button class="side-tool" type="button" onClick={() => setModal("new-channel")}>
                  + Channel
                </button>
                <button class="side-tool" type="button" onClick={() => setModal("people")}>
                  + People
                </button>
              </div>
            </Show>
          </Show>
        </div>

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
          <Match when={server() && channel()?.kind === "voice" && channel()}>
            {(ch) => <VoiceRoom serverId={server()!.id} channel={ch()} uid={props.uid} name={props.name} profiles={profiles()} />}
          </Match>
          <Match when={server() && channel()?.kind === "room" && channel()}>
            {(ch) => <RoomPane serverId={server()!.id} channel={ch()} uid={props.uid} name={props.name} profiles={profiles()} />}
          </Match>
        </Switch>
      </main>

      {/* ---- right: the open tile's chat, otherwise the people ---- */}
      <Show when={server() && tileChat()}>
        {(chat) => (
          <aside class="side-chat" aria-label={`# ${chat().name}`}>
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
            <Chat
              serverId={server()!.id}
              channel={chat()}
              uid={props.uid}
              profiles={profiles()}
              canModerate={runsServer()}
              compact
            />
          </aside>
        )}
      </Show>
      <aside class="members" aria-label="Members" classList={{ hidden: Boolean(tileChat()) }}>
        <Show when={server()}>
          {(s) => {
            const online = () => s().memberUids.filter(isOnline);
            const offline = () => s().memberUids.filter((u) => !isOnline(u));
            return (
              <>
                <MemberGroup label={`Online — ${online().length}`} uids={online()} profiles={profiles()} nameOf={nameOf} online />
                <MemberGroup label={`Offline — ${offline().length}`} uids={offline()} profiles={profiles()} nameOf={nameOf} />
              </>
            );
          }}
        </Show>
      </aside>

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
      <NameDialog
        open={modal() === "rename"}
        title="Rename server"
        label="Server name"
        action="Save"
        initial={server()?.name}
        onClose={() => setModal("")}
        onSubmit={(name) => renameServer(serverId()!, name)}
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

function ChannelGroup(props: {
  label?: string;
  channels: Channel[];
  activeId?: string;
  canEdit: boolean;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <Show when={props.channels.length}>
      <Show when={props.label}>
        <div class="group-label">{props.label}</div>
      </Show>
      <For each={props.channels}>
        {(c) => (
          <div class="chan-row" classList={{ active: c.id === props.activeId }}>
            <button type="button" class="chan" onClick={() => props.onPick(c.id)}>
              <span class="hash">{c.kind === "voice" ? "◉" : "#"}</span>
              <span class="chan-name">{c.name}</span>
            </button>
            <Show when={props.canEdit}>
              <button
                class="icon-btn chan-del"
                type="button"
                title={`Delete ${c.name}`}
                aria-label={`Delete ${c.name}`}
                onClick={() => props.onDelete(c.id)}
              >
                ✕
              </button>
            </Show>
          </div>
        )}
      </For>
    </Show>
  );
}

function MemberGroup(props: {
  label: string;
  uids: string[];
  profiles: Map<string, Profile>;
  nameOf: (uid: string) => string;
  online?: boolean;
}) {
  return (
    <Show when={props.uids.length}>
      <div class="group-label">{props.label}</div>
      <For each={props.uids}>
        {(uid) => (
          <div class="member" classList={{ offline: !props.online }}>
            <span class="avatar small" style={{ background: props.profiles.get(uid)?.color ?? "#404040" }}>
              {initials(props.nameOf(uid))}
              <Show when={props.online}>
                <i class="dot" />
              </Show>
            </span>
            <span class="member-name">{props.nameOf(uid)}</span>
          </div>
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
  const [kind, setKind] = createSignal<Channel["kind"]>("text");
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
    setKind("text");
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
        <div class="kind-pick">
          <label>
            <input type="radio" name="kind" value="text" checked={kind() === "text"} onChange={() => setKind("text")} /> #
            Text
          </label>
          <label>
            <input type="radio" name="kind" value="voice" checked={kind() === "voice"} onChange={() => setKind("voice")} />{" "}
            ◉ Voice / video
          </label>
          <label>
            <input type="radio" name="kind" value="room" checked={kind() === "room"} onChange={() => setKind("room")} /> ▣
            Room tile
          </label>
        </div>
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
