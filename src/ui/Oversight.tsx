import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import { audit } from "../data/audit";
import { type Channel, type Message, type Profile, type Server, displayName, watchAllServers, watchChannels, watchMessages } from "../data/store";
import { auth } from "../firebase";
import { LiveCallWatch } from "./LiveCallWatch";
import { faceStyle, faceText } from "./Shell";
import "./oversight.css";

/*
 * Oversight: staff looks into any server's channels and messages, read-only,
 * without joining it or showing up on its member list (rules:
 * M2A-Access-Control's firestore.rules, servers/{sid} isStaff() read; DMs are
 * excluded there, so a private conversation never shows here). Every server
 * and channel opened is written to the audit log (oversight.view), so the
 * access is on the permanent record even though nothing appears to the
 * people in that server at the time. Disclosed in Darkwood Node's terms of
 * agreement. Lives inside the Dashboard, a tab among the rest of it.
 *
 * Laid out as a drill-down (server -> channel -> messages) instead of three
 * side-by-side panes, since it sits in a half-width column next to Activity
 * on the Tools page - a vertical flow reads better narrow than three boxes
 * squeezed together would.
 */

const KIND_LABEL: Record<Channel["kind"], string> = { text: "#", voice: "🔊", room: "▦" };

// A room Oversight can watch: the same /api/dh-rooms list the Dashboard's
// own Live calls section polls, matched here by server+channel instead of
// shown as its own flat list - so a channel's videochat (or its 3D room)
// shows right where you're already looking at that channel.
type LiveRoom = { name: string; serverId: string; channelId: string; is3dRoom: boolean; numParticipants: number };

export function OversightBody(props: { profiles: Map<string, Profile> }) {
  const [servers, setServers] = createSignal<Server[] | undefined>();
  const [error, setError] = createSignal("");
  const [serverId, setServerId] = createSignal<string | undefined>();
  const [serverQuery, setServerQuery] = createSignal("");
  const [channels, setChannels] = createSignal<Channel[]>([]);
  const [channelId, setChannelId] = createSignal<string | undefined>();
  const [messages, setMessages] = createSignal<Message[]>([]);
  const [liveRooms, setLiveRooms] = createSignal<LiveRoom[]>([]);
  const [watchingRoom, setWatchingRoom] = createSignal<string | undefined>();

  onMount(() => {
    const stop = watchAllServers(setServers, () => setError("Could not load the servers. Only staff can see them."));
    onCleanup(stop);
  });

  async function pollRooms() {
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) return;
      const res = await fetch("/api/dh-rooms", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
      if (!res.ok) return;
      const d = (await res.json()) as { rooms?: LiveRoom[] };
      setLiveRooms(d.rooms ?? []);
    } catch {
      /* the live-now markers just stay as they were; try again next tick */
    }
  }
  onMount(() => {
    void pollRooms();
    const tick = window.setInterval(() => void pollRooms(), 15_000);
    onCleanup(() => window.clearInterval(tick));
  });
  const liveInServer = () => liveRooms().filter((r) => r.serverId === serverId());
  const liveInChannel = () => liveInServer().filter((r) => r.channelId === channelId());

  const server = () => servers()?.find((s) => s.id === serverId());
  const channel = () => channels().find((c) => c.id === channelId());
  const nameOf = (uid: string) => displayName(props.profiles.get(uid), "Member");

  const shownServers = createMemo(() => {
    const term = serverQuery().trim().toLowerCase();
    return (servers() ?? []).filter((s) => !term || s.name.toLowerCase().includes(term));
  });

  function pickServer(sid: string) {
    setServerId(sid === serverId() ? undefined : sid);
  }

  // the chosen server's channels; opening a server is itself a view, logged once per pick
  createEffect(() => {
    const sid = serverId();
    setChannelId(undefined);
    setChannels([]);
    if (!sid) return;
    const s = servers()?.find((x) => x.id === sid);
    audit("oversight.view", { serverId: sid, target: s?.name ?? sid });
    const stop = watchChannels(sid, setChannels);
    onCleanup(stop);
  });

  // the chosen channel's messages, logged once per pick
  createEffect(() => {
    const sid = serverId();
    const cid = channelId();
    setMessages([]);
    setWatchingRoom(undefined);
    if (!sid || !cid) return;
    const s = servers()?.find((x) => x.id === sid);
    const c = channels().find((x) => x.id === cid);
    audit("oversight.view", { serverId: sid, target: s?.name ?? sid, detail: c?.name ?? cid });
    const stop = watchMessages(sid, cid, setMessages);
    onCleanup(stop);
  });

  return (
    <div class="oversight">
      <p class="modal-text">
        Every server, read-only: nobody in it is told you looked, but opening one here is permanently written to the
        audit log.
      </p>
      <Show when={error()}>
        <p class="roles-error" role="alert">
          {error()}
        </p>
      </Show>

      <div class="oversight-step">
        <h4 class="oversight-step-label">Server</h4>
        <input
          class="roles-search"
          type="search"
          placeholder="Find a server"
          aria-label="Find a server"
          value={serverQuery()}
          onInput={(e) => setServerQuery(e.currentTarget.value)}
        />
        <Show when={servers()} fallback={<p class="modal-text">Loading…</p>}>
          <div class="oversight-list">
            <For each={shownServers()} fallback={<p class="modal-text">No servers.</p>}>
              {(s) => (
                <button type="button" class="oversight-pill" aria-pressed={s.id === serverId()} onClick={() => pickServer(s.id)}>
                  {s.name}
                  <span class="oversight-pill-meta">{s.memberUids.length} member{s.memberUids.length === 1 ? "" : "s"}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>

      <Show when={server()}>
        {(s) => (
          <div class="oversight-step">
            <h4 class="oversight-step-label">Channel in {s().name}</h4>
            <div class="oversight-list oversight-list-row">
              <For each={channels()} fallback={<p class="modal-text">No channels.</p>}>
                {(c) => (
                  <button type="button" class="oversight-pill" aria-pressed={c.id === channelId()} onClick={() => setChannelId(c.id)}>
                    {KIND_LABEL[c.kind]} {c.name}
                    <Show when={liveInServer().some((r) => r.channelId === c.id)}>
                      <i class="oversight-live-dot" aria-label="live now" title="A call is active here" />
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>

      <Show when={channel()}>
        {(c) => (
          <div class="oversight-step">
            <h4 class="oversight-step-label">
              {KIND_LABEL[c().kind]} {c().name}
            </h4>
            <For each={liveInChannel()}>
              {(r) => (
                <div class="oversight-live">
                  <span class="oversight-live-head">
                    <i class="oversight-live-dot" aria-label="live" />
                    {r.is3dRoom ? "3D room" : "Videochat"} · {r.numParticipants} in call
                  </span>
                  <button
                    class="btn"
                    type="button"
                    onClick={() => setWatchingRoom(watchingRoom() === r.name ? undefined : r.name)}
                  >
                    {watchingRoom() === r.name ? "Stop watching" : "Watch"}
                  </button>
                  <Show when={watchingRoom() === r.name}>
                    <LiveCallWatch room={r.name} serverName={server()?.name ?? c().name} profiles={props.profiles} onClose={() => setWatchingRoom(undefined)} />
                  </Show>
                </div>
              )}
            </For>
            <div class="oversight-messages">
              <For each={messages()} fallback={<p class="modal-text">No messages.</p>}>
                {(m) => (
                  <div class="oversight-message">
                    <span class="avatar small" style={faceStyle(props.profiles.get(m.authorUid))}>
                      {faceText(props.profiles.get(m.authorUid), nameOf(m.authorUid))}
                    </span>
                    <div class="oversight-message-body">
                      <span class="oversight-message-head">
                        <b>{nameOf(m.authorUid)}</b>
                        <time>{m.createdAt?.toLocaleString() ?? ""}</time>
                      </span>
                      <span class="oversight-message-text">{m.text}</span>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
