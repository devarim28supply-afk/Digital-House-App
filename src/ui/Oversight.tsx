import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";

import { audit } from "../data/audit";
import { type Channel, type Message, type Profile, type Server, displayName, watchAllServers, watchChannels, watchMessages } from "../data/store";
import { Modal } from "./Modal";
import { faceStyle, faceText } from "./Shell";
import "./oversight.css";

/*
 * Oversight: an admin looks into any server's channels and messages,
 * read-only, without joining it or showing up on its member list (rules:
 * M2A-Access-Control's firestore.rules, servers/{sid} isAdmin() read; DMs are
 * excluded there, so a private conversation never shows here). Every server
 * and channel opened in this window is written to the audit log
 * (oversight.view), so the access is on the permanent record even though
 * nothing appears to the people in that server at the time. Disclosed in
 * Darkwood Node's terms of agreement.
 */

const KIND_LABEL: Record<Channel["kind"], string> = { text: "#", voice: "🔊", room: "▦" };

export function OversightDialog(props: { open: boolean; onClose: () => void; profiles: Map<string, Profile> }) {
  return (
    <Modal title="Oversight" class="oversight-modal" open={props.open} onClose={props.onClose}>
      <OversightBody profiles={props.profiles} />
    </Modal>
  );
}

function OversightBody(props: { profiles: Map<string, Profile> }) {
  const [servers, setServers] = createSignal<Server[] | undefined>();
  const [error, setError] = createSignal("");
  const [serverId, setServerId] = createSignal<string | undefined>();
  const [channels, setChannels] = createSignal<Channel[]>([]);
  const [channelId, setChannelId] = createSignal<string | undefined>();
  const [messages, setMessages] = createSignal<Message[]>([]);

  onMount(() => {
    const stop = watchAllServers(setServers, () => setError("Could not load the servers. Only admins can see them."));
    onCleanup(stop);
  });

  const server = () => servers()?.find((s) => s.id === serverId());
  const channel = () => channels().find((c) => c.id === channelId());
  const nameOf = (uid: string) => displayName(props.profiles.get(uid), "Member");

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
      <div class="oversight-panes">
        <div class="oversight-pane oversight-servers">
          <Show when={servers()} fallback={<p class="modal-text">Loading…</p>}>
            <For each={servers()} fallback={<p class="modal-text">No servers.</p>}>
              {(s) => (
                <button
                  type="button"
                  class="oversight-row"
                  aria-pressed={s.id === serverId()}
                  onClick={() => setServerId(s.id)}
                >
                  {s.name}
                </button>
              )}
            </For>
          </Show>
        </div>
        <div class="oversight-pane oversight-channels">
          <Show when={server()} fallback={<p class="modal-text">Pick a server.</p>}>
            <For each={channels()} fallback={<p class="modal-text">No channels.</p>}>
              {(c) => (
                <button
                  type="button"
                  class="oversight-row"
                  aria-pressed={c.id === channelId()}
                  onClick={() => setChannelId(c.id)}
                >
                  {KIND_LABEL[c.kind]} {c.name}
                </button>
              )}
            </For>
          </Show>
        </div>
        <div class="oversight-pane oversight-messages">
          <Show when={channel()} fallback={<p class="modal-text">Pick a channel.</p>}>
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
          </Show>
        </div>
      </div>
    </div>
  );
}
