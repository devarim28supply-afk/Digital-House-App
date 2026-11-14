import { For, type JSX, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";

import { ACTION_LABEL, type AuditAction, type AuditEntry, watchAudit } from "../data/audit";
import { uploadEmoji, uploadPicture } from "../data/files";
import {
  type Channel,
  type Emoji,
  type Profile,
  type Server,
  type ServerRole,
  addEmoji,
  addServerMembers,
  banServerMember,
  deleteEmoji,
  deleteRoomTile,
  deleteServer,
  displayName,
  imageSrc,
  isBuiltInTile,
  isTvChannel,
  orderTiles,
  removeInviteCode,
  removeServerMember,
  renameChannel,
  saveServerExtras,
  saveServerSettings,
  setAnnouncement,
  setServerListed,
  setTileImage,
  shrinkImage,
  topRoleOf,
  unbanServerMember,
} from "../data/store";
import { DeveloperBadge } from "./DeveloperBadge";
import { emojiNameFrom } from "./Emoji";
import { JoinRequestList } from "./JoinRequests";
import { Modal } from "./Modal";
import { InviteCodeField, faceStyle, faceText, initials } from "./Shell";
import "./settings.css";

/**
 * Server settings (Kaalob: all of it, laid out like Discord's, to prune
 * later). The gear by the server's name. Everything about this one server
 * and nothing about your own account: its sections down the left in
 * Discord's groups, the page on the right, the same window as Settings.
 *
 *   (the server)  Server Profile   name, icon, banner, description, announcement
 *                 Engagement       the chat message when someone asks to join
 *                 Channels         rename, picture, order, delete, new
 *   Expression    Emoji, Stickers  add, remove
 *   People        Members          who is in, requests to join, add, remove, ban, roles
 *                 Roles            the server's roles: a name and a color
 *                 Invites          the invite code, on or off
 *                 Access           listed in Find a server or not
 *   Moderation    Safety Setup     words that cannot be sent
 *                 Audit Log        who changed what in this server
 *                 Bans             who is banned, unban
 *   Delete server                  the server and everything in it
 *
 * What Discord has and this leaves out, because Darkwood Node has nothing
 * for it to act on: Server Tag, Boost Perks, Soundboard, Integrations and
 * the App Directory, Community, and Server Template.
 *
 * Roles here are a label and a color. What a person may DO in a server is
 * still decided by the database rules (its owner, admins and staff run it),
 * so a role carries no permissions of its own. The same goes for a ban: it
 * takes the person out, and keeps this app from adding them back or
 * approving their request; a still-valid invite code is turned off
 * separately (Invites).
 */

type Page = "profile" | "engagement" | "channels" | "emoji" | "stickers" | "members" | "roles" | "invites" | "access" | "safety" | "audit" | "bans" | "delete";

const ROLE_COLORS = ["#f87171", "#fb923c", "#facc15", "#4ade80", "#2dd4bf", "#60a5fa", "#a78bfa", "#f472b6", "#e5e7eb"];

export function ServerSettings(props: {
  open: boolean;
  onClose: () => void;
  server?: Server;
  channels: Channel[];
  emojis: Emoji[];
  profiles: Map<string, Profile>;
  uid: string;
  /** the owner may delete it, never the home server */
  canDelete: boolean;
  /** open the New channel dialog (this window closes for it) */
  onNewChannel: () => void;
  /** the page it opens on: "+ People" in the sidebar opens it on Members */
  startOn?: "profile" | "members";
}) {
  const [page, setPageNow] = createSignal<Page>("profile");
  const [error, setError] = createSignal("");
  // On a phone: the list of sections first, then the picked page with a Back
  // button (see Settings.tsx). inPage: a page is open. Picking a section opens it.
  const [inPage, setInPage] = createSignal(false);
  const setPage = (next: Page) => {
    setPageNow(next);
    setInPage(true);
  };
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setPageNow(props.startOn ?? "profile");
        // "+ People" opens straight on Members; the gear opens on the list (on a phone)
        setInPage(props.startOn === "members");
      },
    ),
  );
  const close = () => {
    setError("");
    props.onClose();
  };
  const say = (err: unknown, fallback: string) => setError(err instanceof Error && err.message ? err.message : fallback);
  /** Run a change; a failure shows as the page's error line. */
  const attempt = (work: Promise<unknown>, fallback: string) => {
    setError("");
    return work.then(
      () => true,
      (err) => {
        say(err, fallback);
        return false;
      },
    );
  };
  // a new page starts without the last page's error
  createEffect(on(page, () => setError(""), { defer: true }));

  const groups = (): { label: string; items: { id: Page; label: string }[] }[] => [
    {
      label: props.server?.name ?? "Server",
      items: [
        { id: "profile", label: "Server Profile" },
        { id: "engagement", label: "Engagement" },
        { id: "channels", label: "Channels" },
      ],
    },
    {
      label: "Expression",
      items: [
        { id: "emoji", label: "Emoji" },
        { id: "stickers", label: "Stickers" },
      ],
    },
    {
      label: "People",
      items: [
        { id: "members", label: "Members" },
        { id: "roles", label: "Roles" },
        { id: "invites", label: "Invites" },
        { id: "access", label: "Access" },
      ],
    },
    {
      label: "Moderation",
      items: [
        { id: "safety", label: "Safety Setup" },
        { id: "audit", label: "Audit Log" },
        { id: "bans", label: "Bans" },
      ],
    },
  ];
  const titleOf = (id: Page) => (id === "delete" ? "Delete server" : groups().flatMap((g) => g.items).find((i) => i.id === id)?.label ?? "");

  const Row = (p: { label: string; hint?: string; children: JSX.Element }) => (
    <div class="set-row">
      <b>{p.label}</b>
      {p.children}
      <Show when={p.hint}>
        <small>{p.hint}</small>
      </Show>
    </div>
  );
  const nameOf = (uid: string) => displayName(props.profiles.get(uid), "Member");

  // ---- Server Profile: name, icon, banner, description, announcement (saved together) ----
  // undefined = untouched, null = remove it, string = the new value
  const [banner, setBanner] = createSignal<string | null | undefined>();
  const [icon, setIcon] = createSignal<string | null | undefined>();
  const [uploading, setUploading] = createSignal<"" | "banner" | "icon">("");
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [note, setNote] = createSignal<string | undefined>(); // the announcement being typed
  const [about, setAbout] = createSignal<string | undefined>(); // the description being typed
  const shownBanner = () => (banner() === undefined ? props.server?.banner : banner() ?? undefined);
  const shownIcon = () => (icon() === undefined ? props.server?.icon : icon() ?? undefined);
  // another server (or the window reopened): nothing half-edited carries over
  createEffect(
    on(
      () => [props.server?.id, props.open],
      () => {
        setBanner(undefined);
        setIcon(undefined);
        setNote(undefined);
        setAbout(undefined);
        setSaved(false);
        setWords(undefined);
        setConfirmName("");
      },
    ),
  );
  async function pickPicture(kind: "banner" | "icon", e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || !props.server) return;
    setUploading(kind);
    setError("");
    try {
      const url = await uploadPicture(file, { kind, serverId: props.server.id });
      if (kind === "banner") setBanner(url);
      else setIcon(url);
      setSaved(false);
    } catch (err) {
      say(err, "Could not use that picture");
    } finally {
      setUploading("");
    }
  }
  async function saveProfile(e: SubmitEvent) {
    e.preventDefault();
    const server = props.server;
    if (!server) return;
    const name = String(new FormData(e.currentTarget as HTMLFormElement).get("name") ?? "").trim().slice(0, 60);
    if (!name) return;
    setSaving(true);
    setError("");
    try {
      // servers are never open: people ask to join
      await saveServerSettings(server.id, name, banner(), false, icon(), Boolean(server.unlisted));
      if (note() !== undefined && note() !== (server.announcement ?? "")) await setAnnouncement(server.id, note() ?? "");
      if (about() !== undefined && about() !== (server.description ?? "")) await saveServerExtras(server.id, { description: (about() ?? "").trim().slice(0, 300) }, "description changed");
      setBanner(undefined);
      setIcon(undefined);
      setNote(undefined);
      setAbout(undefined);
      setSaved(true);
    } catch (err) {
      say(err, "Could not save that.");
    } finally {
      setSaving(false);
    }
  }

  // ---- Channels ----
  const tiles = () => props.channels.filter((c) => c.kind === "room").sort((a, b) => a.position - b.position);
  const ownTiles = () => tiles().filter((c) => !isBuiltInTile(c));
  const kindOf = (c: Channel) => (isBuiltInTile(c) ? "Built in" : isTvChannel(c) ? "Television" : c.url ? "Room link" : "Videochat");
  const [renaming, setRenaming] = createSignal("");
  const [armed, setArmed] = createSignal(""); // the thing whose Delete (or Ban) was clicked once
  async function move(c: Channel, by: -1 | 1) {
    const order = ownTiles().map((t) => t.id);
    const i = order.indexOf(c.id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= order.length || !props.server) return;
    [order[i], order[j]] = [order[j], order[i]];
    await attempt(orderTiles(props.server.id, order, props.channels), "Could not move that channel.");
  }
  async function rename(c: Channel, raw: string) {
    const name = raw.trim().slice(0, 40);
    setRenaming("");
    if (!name || name === c.name || !props.server) return;
    await attempt(renameChannel(props.server.id, c.id, name), "Could not rename that channel.");
  }
  async function repicture(c: Channel, e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || !props.server) return;
    try {
      await setTileImage(props.server.id, c.id, await shrinkImage(file, 480), c.name);
    } catch (err) {
      say(err, "Could not use that picture");
    }
  }
  async function removeChannel(c: Channel) {
    if (armed() !== c.id) return void setArmed(c.id);
    setArmed("");
    if (!props.server) return;
    await attempt(deleteRoomTile(props.server.id, c.id, props.channels), "Could not delete that channel.");
  }

  // ---- Emoji, Stickers ----
  const [adding, setAdding] = createSignal<"" | "emoji" | "sticker">("");
  const ofKind = (kind: "emoji" | "sticker") => props.emojis.filter((e) => (e.kind ?? "emoji") === kind).sort((a, b) => a.name.localeCompare(b.name));
  async function addPicture(kind: "emoji" | "sticker", e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    if (!files.length || !props.server) return;
    setAdding(kind);
    setError("");
    try {
      for (const file of files) {
        // its file name is its name; a name already used gets a number
        const base = emojiNameFrom(file.name);
        let name = base.length < 2 ? `${kind}_${base || "x"}`.slice(0, 32) : base;
        const taken = new Set(ofKind(kind).map((x) => x.name));
        for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 28)}_${n}`;
        const url = await uploadEmoji(props.server.id, file);
        await addEmoji(props.server.id, { name, url, addedBy: props.uid, animated: file.type === "image/gif", kind });
      }
    } catch (err) {
      say(err, kind === "emoji" ? "Could not add that emoji" : "Could not add that sticker");
    } finally {
      setAdding("");
    }
  }
  async function removeEmoji(emoji: Emoji) {
    if (armed() !== emoji.id) return void setArmed(emoji.id);
    setArmed("");
    if (!props.server) return;
    await attempt(deleteEmoji(props.server.id, emoji.id, emoji.name), "Could not remove that.");
  }
  const EmojiPage = (p: { kind: "emoji" | "sticker" }) => (
    <>
      <p class="set-note">
        {p.kind === "emoji"
          ? "Pictures and little GIFs to use in messages as :name:. Up to 2 MB each. The file's name becomes the emoji's name."
          : "Bigger pictures sent on their own from the sticker tab. Up to 2 MB each."}
      </p>
      <div class="set-actions">
        <label class="btn primary banner-upload">
          {adding() === p.kind ? "Adding…" : p.kind === "emoji" ? "+ Upload emoji" : "+ Upload stickers"}
          <input type="file" multiple accept="image/png,image/gif,image/webp,image/jpeg" disabled={Boolean(adding())} onChange={(e) => void addPicture(p.kind, e)} />
        </label>
      </div>
      <Show when={ofKind(p.kind).length} fallback={<p class="set-note">None yet.</p>}>
        <div class="ss-emojis" classList={{ stickers: p.kind === "sticker" }}>
          <For each={ofKind(p.kind)}>
            {(emoji) => (
              <div class="ss-emoji">
                <img src={emoji.url} alt="" loading="lazy" />
                <span title={p.kind === "emoji" ? `:${emoji.name}:` : emoji.name}>{p.kind === "emoji" ? `:${emoji.name}:` : emoji.name}</span>
                <small>by {nameOf(emoji.addedBy)}</small>
                <button class="btn danger" type="button" onClick={() => void removeEmoji(emoji)}>
                  {armed() === emoji.id ? "Click again" : "Remove"}
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </>
  );

  // ---- Members ----
  const [find, setFind] = createSignal("");
  const inServer = (uid: string) => Boolean(props.server?.memberUids.includes(uid));
  const banned = (uid: string) => Boolean(props.server?.bannedUids?.includes(uid));
  const matches = (p: Profile) => !find().trim() || `${displayName(p)} ${p.name} ${p.username}`.toLowerCase().includes(find().trim().toLowerCase());
  const everyone = () => [...props.profiles.values()].filter(matches).sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const members = () => everyone().filter((p) => inServer(p.uid));
  const others = () => everyone().filter((p) => !inServer(p.uid) && !banned(p.uid));
  const Person = (p: { profile: Profile; children: JSX.Element }) => (
    <div class="person">
      <span class="avatar small" style={faceStyle(p.profile)}>
        {faceText(p.profile, displayName(p.profile))}
      </span>
      <span class="member-name" style={topRoleOf(props.server, p.profile.uid) ? { color: topRoleOf(props.server, p.profile.uid)!.color } : undefined}>
        {displayName(p.profile)}
        <DeveloperBadge username={p.profile.username} /> <small>@{p.profile.username}</small>
      </span>
      {p.children}
    </div>
  );
  async function ban(uid: string) {
    if (armed() !== `ban:${uid}`) return void setArmed(`ban:${uid}`);
    setArmed("");
    if (props.server) await attempt(banServerMember(props.server.id, uid), "Could not ban them.");
  }

  // ---- Roles: a name and a color; a person's name takes the color of their first role ----
  const roles = () => props.server?.roles ?? [];
  const rolesOf = (uid: string) => props.server?.memberRoles?.[uid] ?? [];
  const saveRoles = (next: ServerRole[], what: string, memberRoles = props.server?.memberRoles) =>
    props.server ? attempt(saveServerExtras(props.server.id, { roles: next, memberRoles: memberRoles ?? {} }, what), "Could not save the roles.") : Promise.resolve(false);
  function addRole() {
    const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    void saveRoles([...roles(), { id, name: "new role", color: ROLE_COLORS[roles().length % ROLE_COLORS.length] }], "role added");
  }
  function changeRole(id: string, patch: Partial<ServerRole>) {
    const next = roles().map((r) => (r.id === id ? { ...r, ...patch } : r));
    void saveRoles(next, "role changed");
  }
  function moveRole(id: string, by: -1 | 1) {
    const next = [...roles()];
    const i = next.findIndex((r) => r.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    void saveRoles(next, "roles put in a new order");
  }
  function removeRole(id: string) {
    if (armed() !== id) return void setArmed(id);
    setArmed("");
    // nobody keeps a role that is gone
    const memberRoles = Object.fromEntries(Object.entries(props.server?.memberRoles ?? {}).map(([uid, ids]) => [uid, ids.filter((x) => x !== id)]));
    void saveRoles(roles().filter((r) => r.id !== id), "role deleted", memberRoles);
  }
  function toggleRole(uid: string, roleId: string) {
    if (!props.server) return;
    const mine = rolesOf(uid);
    const next = mine.includes(roleId) ? mine.filter((x) => x !== roleId) : [...mine, roleId];
    void attempt(saveServerExtras(props.server.id, { memberRoles: { ...(props.server.memberRoles ?? {}), [uid]: next } }, "a member's roles changed"), "Could not change their roles.");
  }
  const countWith = (roleId: string) => (props.server?.memberUids ?? []).filter((uid) => rolesOf(uid).includes(roleId)).length;

  // ---- Safety Setup: blocked words ----
  const [words, setWords] = createSignal<string | undefined>();
  const wordsText = () => words() ?? (props.server?.blockedWords ?? []).join("\n");
  async function saveWords() {
    if (!props.server) return;
    const list = [...new Set(wordsText().split(/[\n,]+/).map((w) => w.trim().toLowerCase()).filter(Boolean))].slice(0, 200);
    if (await attempt(saveServerExtras(props.server.id, { blockedWords: list }, `${list.length} blocked words`), "Could not save the words.")) setWords(undefined);
  }

  // ---- Audit Log: read only while its page is open ----
  const [entries, setEntries] = createSignal<AuditEntry[] | undefined>();
  const [auditError, setAuditError] = createSignal(false);
  createEffect(() => {
    if (!props.open || page() !== "audit") return;
    setEntries(undefined);
    setAuditError(false);
    onCleanup(watchAudit(setEntries, () => setAuditError(true)));
  });
  const serverEntries = createMemo(() => (entries() ?? []).filter((e) => e.serverId === props.server?.id));
  const when = (at: number) => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  // ---- Delete ----
  const [deleting, setDeleting] = createSignal(false);
  const [confirmName, setConfirmName] = createSignal("");
  async function removeServer() {
    if (!props.server || confirmName().trim() !== props.server.name) return;
    setDeleting(true);
    try {
      await deleteServer(props.server.id);
      setConfirmName("");
      close();
    } catch (err) {
      say(err, "Could not delete the server.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal title="Server settings" class="settings" open={props.open} onClose={close}>
      <div class="set" classList={{ "in-page": inPage() }}>
        <nav class="set-nav" aria-label="Server settings sections">
          <For each={groups()}>
            {(group) => (
              <>
                <span class="set-nav-label">{group.label}</span>
                <For each={group.items}>
                  {(item) => (
                    <button type="button" class="set-nav-item" aria-current={page() === item.id ? "page" : undefined} onClick={() => setPage(item.id)}>
                      {item.label}
                      <Show when={item.id === "bans" && props.server?.bannedUids?.length}>
                        <span class="set-nav-count">{props.server?.bannedUids?.length}</span>
                      </Show>
                    </button>
                  )}
                </For>
              </>
            )}
          </For>
          <Show when={props.canDelete}>
            <span class="set-nav-gap" aria-hidden="true" />
            <button type="button" class="set-nav-item danger" aria-current={page() === "delete" ? "page" : undefined} onClick={() => setPage("delete")}>
              Delete server
            </button>
          </Show>
        </nav>

        <section class="set-page" aria-label={titleOf(page())}>
          {/* a phone only: back to the list of sections */}
          <button type="button" class="set-back" onClick={() => setInPage(false)}>
            ‹ Server settings
          </button>
          <h3 class="set-title">{titleOf(page())}</h3>
          <Show when={error()}>
            <p class="form-error">{error()}</p>
          </Show>
          <Switch>
            <Match when={page() === "profile"}>
              <form class="set-form" onSubmit={saveProfile}>
                <Row label="Server name">
                  <label class="field">
                    <input name="name" value={props.server?.name ?? ""} maxLength={60} required onInput={() => setSaved(false)} />
                  </label>
                </Row>
                <Row label="Icon" hint="The server's button on the left. A square picture works best. A GIF keeps moving.">
                  <div class="icon-row">
                    <div class="icon-preview">
                      <Show when={shownIcon()} fallback={initials(props.server?.name ?? "")}>
                        {(src) => <img src={src()} alt="" />}
                      </Show>
                    </div>
                    <div class="banner-actions">
                      <label class="btn banner-upload">
                        {uploading() === "icon" ? "Uploading…" : shownIcon() ? "Change picture or GIF" : "Upload picture or GIF"}
                        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={Boolean(uploading())} onChange={(e) => void pickPicture("icon", e)} />
                      </label>
                      <Show when={shownIcon()}>
                        <button class="btn danger" type="button" onClick={() => { setIcon(null); setSaved(false); }}>
                          Remove
                        </button>
                      </Show>
                    </div>
                  </div>
                </Row>
                <Row label="Banner" hint="The picture across the top of the channel list. Wide pictures work best (about 3 : 1). A GIF keeps moving.">
                  <div class="banner-preview">
                    <Show when={shownBanner()} fallback={<div class="banner-empty">No banner</div>}>
                      {(src) => <img src={src()} alt="" />}
                    </Show>
                  </div>
                  <div class="banner-actions">
                    <label class="btn banner-upload">
                      {uploading() === "banner" ? "Uploading…" : shownBanner() ? "Change picture" : "Upload picture"}
                      <input type="file" accept="image/*" disabled={Boolean(uploading())} onChange={(e) => void pickPicture("banner", e)} />
                    </label>
                    <Show when={shownBanner()}>
                      <button class="btn danger" type="button" onClick={() => { setBanner(null); setSaved(false); }}>
                        Remove
                      </button>
                    </Show>
                  </div>
                </Row>
                <Row label="Description" hint="A few words about this server, for the people who run it and for anyone you show it to. Up to 300 letters.">
                  <label class="field">
                    <textarea class="ss-note" rows={2} maxLength={300} placeholder="What is this server for?" value={about() ?? props.server?.description ?? ""} onInput={(e) => { setAbout(e.currentTarget.value); setSaved(false); }} />
                  </label>
                </Row>
                <Row label="Announcement" hint="One message for everyone, shown under the server's name. Leave it empty for none.">
                  <label class="field">
                    <textarea class="ss-note" rows={3} maxLength={500} placeholder="Write an announcement for everyone in this server" value={note() ?? props.server?.announcement ?? ""} onInput={(e) => { setNote(e.currentTarget.value); setSaved(false); }} />
                  </label>
                </Row>
                <div class="set-actions">
                  <button class="btn primary" type="submit" disabled={saving() || Boolean(uploading())}>
                    {saving() ? "Saving…" : "Save changes"}
                  </button>
                  <Show when={saved()}>
                    <span class="set-saved">Saved</span>
                  </Show>
                </div>
              </form>
            </Match>

            <Match when={page() === "engagement"}>
              <label class="access-toggle">
                <span>
                  <b>Send a message when someone asks to join</b>
                  <small>When a person asks to join from Find a server, a message goes in the server's first chat so the people who run it see it. The request always shows under Members, on or off.</small>
                </span>
                <input
                  type="checkbox"
                  checked={props.server?.announceJoins !== false}
                  onChange={(e) => props.server && void attempt(saveServerExtras(props.server.id, { announceJoins: e.currentTarget.checked }, e.currentTarget.checked ? "join messages on" : "join messages off"), "Could not save that.")}
                />
              </label>
            </Match>

            <Match when={page() === "channels"}>
              <p class="set-note">Node Lounge and Living Room are in every server: they stay at the top and cannot be deleted. Your own channels can be renamed, moved and deleted.</p>
              <div class="ss-channels">
                <For each={tiles()}>
                  {(c) => (
                    <div class="ss-channel">
                      <img class="ss-channel-pic" src={imageSrc(c.image)} alt="" />
                      <div class="ss-channel-text">
                        <Show when={renaming() === c.id} fallback={<b>{c.name}</b>}>
                          <input
                            class="ss-rename"
                            value={c.name}
                            maxLength={40}
                            ref={(el) => queueMicrotask(() => el.select())}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void rename(c, e.currentTarget.value);
                              if (e.key === "Escape") {
                                e.stopPropagation();
                                setRenaming("");
                              }
                            }}
                            onBlur={(e) => void rename(c, e.currentTarget.value)}
                          />
                        </Show>
                        <small>{kindOf(c)}</small>
                      </div>
                      <div class="ss-channel-tools">
                        <label class="btn banner-upload" title={`Change the picture of ${c.name}`}>
                          Picture
                          <input type="file" accept="image/*" onChange={(e) => void repicture(c, e)} />
                        </label>
                        <Show when={!isBuiltInTile(c)}>
                          <button class="btn" type="button" onClick={() => setRenaming(c.id)}>
                            Rename
                          </button>
                          <button class="btn" type="button" title="Move up" aria-label={`Move ${c.name} up`} disabled={ownTiles()[0]?.id === c.id} onClick={() => void move(c, -1)}>
                            ↑
                          </button>
                          <button class="btn" type="button" title="Move down" aria-label={`Move ${c.name} down`} disabled={ownTiles().at(-1)?.id === c.id} onClick={() => void move(c, 1)}>
                            ↓
                          </button>
                          <button class="btn danger" type="button" onClick={() => void removeChannel(c)}>
                            {armed() === c.id ? "Click again to delete" : "Delete"}
                          </button>
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
              </div>
              <div class="set-actions">
                <button class="btn primary" type="button" onClick={props.onNewChannel}>
                  + New channel
                </button>
              </div>
            </Match>

            <Match when={page() === "emoji"}>
              <EmojiPage kind="emoji" />
            </Match>
            <Match when={page() === "stickers"}>
              <EmojiPage kind="sticker" />
            </Match>

            <Match when={page() === "members"}>
              <Show when={props.server}>{(s) => <JoinRequestList serverId={s().id} banned={s().bannedUids} />}</Show>
              <label class="field">
                <input value={find()} placeholder="Search names" onInput={(e) => setFind(e.currentTarget.value)} />
              </label>
              <Row label={`In this server (${members().length})`} hint={roles().length ? "Click a role to give it or take it away. Remove takes them out; Ban also keeps them out." : "Remove takes them out; Ban also keeps them out. Make roles on the Roles page to give them here."}>
                <div class="people-list">
                  <For each={members()}>
                    {(p) => (
                      <Person profile={p}>
                        <span class="ss-roles">
                          <For each={roles()}>
                            {(role) => (
                              <button type="button" class="ss-role-chip" style={{ "--role": role.color }} aria-pressed={rolesOf(p.uid).includes(role.id)} title={rolesOf(p.uid).includes(role.id) ? `Take ${role.name} away` : `Give ${role.name}`} onClick={() => toggleRole(p.uid, role.id)}>
                                {role.name}
                              </button>
                            )}
                          </For>
                        </span>
                        <Show when={p.uid !== props.server?.ownerUid} fallback={<span class="person-tag">owner</span>}>
                          <button class="btn danger" type="button" onClick={() => props.server && void attempt(removeServerMember(props.server.id, p.uid), "Could not remove them.")}>
                            Remove
                          </button>
                          <button class="btn danger" type="button" onClick={() => void ban(p.uid)}>
                            {armed() === `ban:${p.uid}` ? "Click again to ban" : "Ban"}
                          </button>
                        </Show>
                      </Person>
                    )}
                  </For>
                </div>
              </Row>
              <Row label={`Not in this server (${others().length})`} hint="Everyone here is an approved member of Darkwood Node. Add them to let them see this server.">
                <div class="people-list">
                  <For each={others()}>
                    {(p) => (
                      <Person profile={p}>
                        <button class="btn" type="button" onClick={() => props.server && void attempt(addServerMembers(props.server.id, [p.uid]), "Could not add them.")}>
                          Add
                        </button>
                      </Person>
                    )}
                  </For>
                </div>
              </Row>
            </Match>

            <Match when={page() === "roles"}>
              <p class="set-note">A role is a name and a color. A person's name, in chat and in the people list, takes the color of the first role they have in this list, so put the most important role at the top. Give roles to people on the Members page.</p>
              <Show when={roles().length} fallback={<p class="set-note">No roles yet.</p>}>
                <div class="ss-channels">
                  <For each={roles()}>
                    {(role, i) => (
                      <div class="ss-role">
                        <input type="color" class="ss-role-color" value={role.color} title="Color" aria-label={`Color of ${role.name}`} onChange={(e) => changeRole(role.id, { color: e.currentTarget.value })} />
                        <input class="ss-rename" value={role.name} maxLength={32} aria-label="Role name" style={{ color: role.color }} onChange={(e) => changeRole(role.id, { name: e.currentTarget.value.trim().slice(0, 32) || role.name })} />
                        <small>{countWith(role.id)} people</small>
                        <div class="ss-channel-tools">
                          <button class="btn" type="button" title="Move up" aria-label={`Move ${role.name} up`} disabled={i() === 0} onClick={() => moveRole(role.id, -1)}>
                            ↑
                          </button>
                          <button class="btn" type="button" title="Move down" aria-label={`Move ${role.name} down`} disabled={i() === roles().length - 1} onClick={() => moveRole(role.id, 1)}>
                            ↓
                          </button>
                          <button class="btn danger" type="button" onClick={() => removeRole(role.id)}>
                            {armed() === role.id ? "Click again to delete" : "Delete"}
                          </button>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              <div class="set-actions">
                <button class="btn primary" type="button" onClick={addRole}>
                  + Create role
                </button>
              </div>
              <p class="set-note">Roles do not give permissions yet: the server's owner and admins are the ones who can change it.</p>
            </Match>

            <Match when={page() === "invites"}>
              <InviteCodeField server={props.server} />
              <Show when={props.server?.inviteCode}>
                <Row label="Turn the invite code off" hint="The code stops working at once. Nobody can join with it until you create a new one.">
                  <div class="set-actions">
                    <button class="btn danger" type="button" onClick={() => props.server && void attempt(removeInviteCode(props.server.id), "Could not turn the code off.")}>
                      Turn invites off
                    </button>
                  </div>
                </Row>
              </Show>
            </Match>

            <Match when={page() === "access"}>
              <label class="access-toggle">
                <span>
                  <b>Show this server in Find a server</b>
                  <small>On: any approved member can find it by name and ask to join; you approve or decline under Members. Off: it is not listed, and people get in only with the invite code or when you add them.</small>
                </span>
                <input
                  type="checkbox"
                  checked={!props.server?.unlisted}
                  onChange={(e) => props.server && void attempt(setServerListed(props.server.id, props.server.name, e.currentTarget.checked), "Could not change that.")}
                />
              </label>
              <p class="set-note">Three ways into a server: asking from Find a server (this switch), the invite code (Invites), and being added by the people who run it (Members).</p>
            </Match>

            <Match when={page() === "safety"}>
              <Row label="Blocked words" hint="One word or phrase on each line. A message with one of them is not sent, and the person is told why. Whole words only: blocking a word does not block longer words that contain it.">
                <label class="field">
                  <textarea class="ss-note" rows={7} placeholder={"one word or phrase\non each line"} value={wordsText()} onInput={(e) => setWords(e.currentTarget.value)} />
                </label>
                <div class="set-actions">
                  <button class="btn primary" type="button" disabled={words() === undefined} onClick={() => void saveWords()}>
                    Save words
                  </button>
                  <span class="set-saved">{(props.server?.blockedWords ?? []).length} blocked now</span>
                </div>
              </Row>
              <p class="set-note">A message already in the chat that has a blocked word is hidden for everyone except the people who run the server.</p>
            </Match>

            <Match when={page() === "audit"}>
              <Show when={!auditError()} fallback={<p class="set-note">The audit log can be read by Darkwood Node staff only.</p>}>
                <Show when={entries()} fallback={<p class="set-note">Loading…</p>}>
                  <Show when={serverEntries().length} fallback={<p class="set-note">Nothing recorded for this server in the latest 300 actions.</p>}>
                    <div class="ss-audit">
                      <For each={serverEntries()}>
                        {(entry) => (
                          <div class="ss-audit-row">
                            <time>{when(entry.at)}</time>
                            <span>
                              <b>{nameOf(entry.uid)}</b> {ACTION_LABEL[entry.action as AuditAction] ?? entry.action}
                              <Show when={entry.target}>
                                {" "}
                                <i>{props.profiles.has(entry.target ?? "") ? nameOf(entry.target!) : entry.target}</i>
                              </Show>
                              <Show when={entry.detail}>
                                <small> · {entry.detail}</small>
                              </Show>
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              </Show>
            </Match>

            <Match when={page() === "bans"}>
              <p class="set-note">A banned person is out of the server and stays out: they are not listed to add back, and a request from them is not approved, until you unban them. Ban someone from the Members page.</p>
              <Show when={props.server?.bannedUids?.length} fallback={<p class="set-note">Nobody is banned.</p>}>
                <div class="people-list">
                  <For each={props.server?.bannedUids ?? []}>
                    {(uid) => (
                      <div class="person">
                        <span class="avatar small" style={faceStyle(props.profiles.get(uid))}>
                          {faceText(props.profiles.get(uid), nameOf(uid))}
                        </span>
                        <span class="member-name">
                          {nameOf(uid)} <small>@{props.profiles.get(uid)?.username ?? "member"}</small>
                        </span>
                        <button class="btn" type="button" onClick={() => props.server && void attempt(unbanServerMember(props.server.id, uid), "Could not unban them.")}>
                          Unban
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Match>

            <Match when={page() === "delete"}>
              <Row label="Delete this server" hint="This removes the server, its channels and every message in them. It cannot be undone.">
                <label class="field">
                  <span>Type the server's name to confirm: {props.server?.name}</span>
                  <input value={confirmName()} onInput={(e) => setConfirmName(e.currentTarget.value)} autocomplete="off" />
                </label>
                <div class="set-actions">
                  <button class="btn danger" type="button" disabled={deleting() || confirmName().trim() !== (props.server?.name ?? "")} onClick={() => void removeServer()}>
                    {deleting() ? "Deleting…" : "Delete server for good"}
                  </button>
                </div>
              </Row>
            </Match>
          </Switch>
        </section>
      </div>
    </Modal>
  );
}
