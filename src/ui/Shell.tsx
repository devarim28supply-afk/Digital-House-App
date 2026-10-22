import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import {
  type Channel,
  ONLINE_WINDOW_MS,
  type Profile,
  type Server,
  addServerMembers,
  createChannel,
  createServer,
  deleteChannel,
  ensureHomeServer,
  removeServerMember,
  renameServer,
  saveProfile,
  startPresence,
  watchChannels,
  watchPresence,
  watchProfiles,
  watchServers,
} from "../data/store";
import { Chat } from "./Chat";
import { Modal } from "./Modal";
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
    const stop = watchChannels(sid, (list) => {
      setChannels(list);
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

  const textChannels = () => channels().filter((c) => c.kind === "text");
  const voiceChannels = () => channels().filter((c) => c.kind === "voice");

  return (
    <div class="shell" classList={{ "nav-open": navOpen() }}>
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
            <span class="hash">{channel()?.kind === "voice" ? "◉" : "#"}</span> {channel()?.name ?? ""}
          </span>
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
        </Switch>
      </main>

      {/* ---- people ---- */}
      <aside class="members" aria-label="Members">
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
        onSubmit={(name, kind) => createChannel(serverId()!, name, kind, channels().length)}
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
  label: string;
  channels: Channel[];
  activeId?: string;
  canEdit: boolean;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <Show when={props.channels.length}>
      <div class="group-label">{props.label}</div>
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
  onSubmit: (name: string, kind: Channel["kind"]) => Promise<unknown>;
}) {
  return (
    <Modal title="New channel" open={props.open} onClose={props.onClose}>
      <form
        class="modal-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const name = String(form.get("name") ?? "").trim().slice(0, 40);
          if (!name) return;
          await props.onSubmit(name, form.get("kind") === "voice" ? "voice" : "text");
          props.onClose();
        }}
      >
        <label class="field">
          <span>Channel name</span>
          <input name="name" maxLength={40} required />
        </label>
        <div class="kind-pick">
          <label>
            <input type="radio" name="kind" value="text" checked /> # Text
          </label>
          <label>
            <input type="radio" name="kind" value="voice" /> ◉ Voice / video
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn" type="button" onClick={props.onClose}>
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
