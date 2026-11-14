import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js";
import { Portal, delegateEvents } from "solid-js/web";

import { Room, RoomEvent } from "livekit-client";

import { type Profile, displayName } from "../data/store";
import { deafened } from "../data/callControls";
import { askTvObs, askTvShared, tvObs, tvObsBusy, tvObsCall, tvShared } from "../data/tvObs";
import { inRoom } from "../data/where";
import { auth } from "../firebase";
import { captionVideo } from "../room/livecaptions";
import { SOURCES, failedChannels, loadChannels, playChannel } from "../room/tv";
import { Modal } from "./Modal";

type Tv = { id: number; name: string; url: string; at: number; onAt: number };
/** A channel from the playlists (room/tv.js). */
type TvChannel = { name: string; logo: string; group: string; url: string };
/** The channel you chose for your own side TV. */
type Picked = { name: string; url: string };

/**
 * A channel's own caption text as the lines to show: tags out, empty rows
 * out, and only the newest two (Kaalob: two lines at a time).
 */
function lastTwoLines(text: string) {
  return text
    .split("\n")
    .map((row) => row.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-2)
    .join("\n");
}
/** Keep `set` on the channel's own captions while it plays. Returns stop(). */
function followCaptions(player: { getCaptionText: () => string }, set: (text: string) => void) {
  const timer = window.setInterval(() => set(lastTwoLines(player.getCaptionText())), 200);
  return () => {
    window.clearInterval(timer);
    set("");
  };
}

/** 0 = captions off, 1 = the television's own, 2 = live captions made here. */
type CcMode = 0 | 1 | 2;
const CC_KEY = "dh_side_tv_cc";
function recallCcMode(): CcMode {
  try {
    const saved = localStorage.getItem(CC_KEY);
    return saved === "1" ? 1 : saved === "2" ? 2 : 0;
  } catch {
    return 0;
  }
}

// your own channel, kept in this browser so the TV is still on it next time
const PICKED_KEY = "dh_side_tv";
function recallPicked(): Picked | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(PICKED_KEY) || "null") as Picked | null;
    return saved && typeof saved.name === "string" && /^https:\/\//.test(saved.url ?? "") ? { name: saved.name, url: saved.url } : undefined;
  } catch {
    return undefined;
  }
}
function rememberPicked(next: Picked | undefined) {
  try {
    if (next) localStorage.setItem(PICKED_KEY, JSON.stringify(next));
    else localStorage.removeItem(PICKED_KEY);
  } catch {
    /* private window: it lasts for this visit */
  }
}

/**
 * The TV screen at the top of the right side bar, above the people and the
 * chat (Kaalob). It is always there. A click on it lists every channel to
 * choose from. The TV is the same for everyone (Kaalob: they see what I
 * see): the channel one person picks plays on the TV of everyone in this
 * channel's videochat, and Off turns it off for everyone (data/tvObs.ts,
 * tvShared). Each browser plays the channel itself; only which channel it
 * is travels. Captions, sound, pop out and full screen stay your own.
 * (Outside the videochat there is nobody to share with: the TV is then your
 * own, on the channel you last picked there.) Hovering shows CC (captions), OBS and Off. There is no big
 * view for now (Kaalob: not needed right now).
 *
 * OBS (data/tvObs.ts): anyone in this channel's videochat can put their OBS
 * picture on this TV for everyone in it, with the OBS button. While it is on
 * it takes over the screen (no channel plays under it); when it stops, the
 * TV goes back to the channel it had.
 *
 * With no channel of your own, it shows the first TV turned on in the open
 * tile's Darkwood Room (props.room), only while a TV is on there; when that
 * one goes off, the next one still on (turned on earliest) takes its place,
 * and a channel change follows along. Hide takes that one off until that TV
 * is turned off (a different first TV brings it back). Muted to start (the
 * speaker is yours alone).
 *
 * The room says which TVs are on in its people's LiveKit attributes
 * (room.js publishTvs); this watches the room unseen (a hidden, watch-only
 * pass), so it works without opening the Room side.
 */
export function SideTv(props: { serverId: string; channelId: string; profiles: Map<string, Profile>; room: boolean }) {
  const [tv, setTv] = createSignal<Tv | undefined>();
  // your own channel, and the list it is chosen from
  // Outside the videochat: your own channel, kept in this browser.
  const [ownPick, setOwnPick] = createSignal<Picked | undefined>(recallPicked());
  // In the videochat: the one channel everyone is on (or none: off).
  const sharedPick = () => {
    const s = tvShared();
    return s && s.channelKey === `${props.serverId}/${props.channelId}` && !s.off ? { name: s.name, url: s.url } : undefined;
  };
  const sharing = () => tvObsCall() === `${props.serverId}/${props.channelId}`;
  const picked = (): Picked | undefined => (sharing() ? sharedPick() : ownPick());
  const [picking, setPicking] = createSignal(false);
  function choose(next: Picked | undefined) {
    setPicking(false);
    if (sharing()) {
      // for everyone in the videochat: the call tells them (and this TV follows it too)
      askTvShared(`${props.serverId}/${props.channelId}`, next ?? null);
      return;
    }
    setOwnPick(next);
    rememberPicked(next);
  }
  const [sound, setSound] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [video, setVideo] = createSignal<HTMLVideoElement>();
  // where live captions (Caption 2, livecaptions.js) are written
  const [ccBox, setCcBox] = createSignal<HTMLDivElement>();
  // The captions never sit on the picture (Kaalob): they go in a strip under
  // the screen, two lines at a time. The channel's own CC is read as text
  // (ownCc); live captions fill the box in the same strip.
  const [ownCc, setOwnCc] = createSignal("");
  // Captions (Kaalob): one CC button, shown while the pointer is over the TV.
  // Each click moves on: off -> Caption 1 (the television's own) -> Caption 2
  // (live captions made here from the sound, for a channel that has none) ->
  // off. Where you leave it is kept in this browser.
  const [ccMode, setCcModeNow] = createSignal<CcMode>(recallCcMode());
  const nextCc = () => {
    const next = ((ccMode() + 1) % 3) as CcMode;
    setCcModeNow(next);
    try {
      localStorage.setItem(CC_KEY, String(next));
    } catch {
      /* private window: it lasts for this visit */
    }
  };
  // Hide: this TV (screen and when it was turned on) stays out of the side bar
  const keyOf = (t: Tv) => `${t.id}|${t.onAt}`;
  const [hidden, setHidden] = createSignal("");
  const shown = () => {
    const now = tv();
    return now && keyOf(now) !== hidden() ? now : undefined;
  };
  // what is on the screen: your own channel first, else the room's TV
  const playing = createMemo<Picked | undefined>(
    () => {
      const mine = picked();
      if (mine) return mine;
      const room = shown();
      return room ? { name: room.name, url: room.url } : undefined;
    },
    undefined,
    { equals: (a, b) => a?.url === b?.url && a?.name === b?.name },
  );

  // the room, watched unseen
  createEffect(() => {
    const { serverId, channelId } = props;
    // a tile without a Darkwood Room has no room TV to follow
    if (!props.room) return;
    const tag = `tv${Math.random().toString(36).slice(2, 8)}`;
    let room: Room | undefined;
    let gone = false;
    let retry = 0;
    const read = () => {
      if (!room) return;
      // every person in the room says the same TVs; take the newest word per screen
      const screens = new Map<number, Tv>();
      for (const p of room.remoteParticipants.values()) {
        let list: Tv[] = [];
        try {
          list = JSON.parse(p.attributes["dw-tv"] || "[]") as Tv[];
        } catch {
          /* not a list */
        }
        for (const t of list) {
          if (typeof t?.url !== "string" || !/^https:\/\//.test(t.url)) continue;
          const had = screens.get(t.id);
          if (!had || t.at > had.at) screens.set(t.id, t);
        }
      }
      const first = [...screens.values()].sort((a, b) => a.onAt - b.onAt || a.id - b.id)[0];
      setTv((now) => (now?.url === first?.url && now?.id === first?.id ? now : first));
    };
    async function connect() {
      try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken || gone) return;
        const res = await fetch("/api/dh-token", {
          method: "POST",
          headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ serverId, channelId, room: true, peek: tag }),
        });
        const pass = (await res.json()) as { url?: string; token?: string };
        if (!res.ok || !pass.url || !pass.token || gone) throw new Error("no pass");
        const next = new Room();
        next
          .on(RoomEvent.ParticipantAttributesChanged, read)
          .on(RoomEvent.ParticipantConnected, read)
          .on(RoomEvent.ParticipantDisconnected, read)
          .on(RoomEvent.Disconnected, () => {
            setTv(undefined);
            if (!gone) retry = window.setTimeout(() => void connect(), 5000);
          });
        // nothing to download: only the attributes are read
        await next.connect(pass.url, pass.token, { autoSubscribe: false });
        if (gone) return void next.disconnect();
        room = next;
        read();
      } catch {
        if (!gone) retry = window.setTimeout(() => void connect(), 10_000);
      }
    }
    void connect();
    onCleanup(() => {
      gone = true;
      window.clearTimeout(retry);
      setTv(undefined);
      void room?.disconnect();
    });
  });

  // ---- OBS on this TV -----------------------------------------------------
  const channelKey = () => `${props.serverId}/${props.channelId}`;
  const obs = createMemo(() => {
    const on = tvObs();
    return on && on.channelKey === channelKey() ? on : undefined;
  });
  // you are in this channel's videochat: only then can your OBS go on its TV
  const inCall = () => tvObsCall() === channelKey();
  const obsName = () => {
    const on = obs();
    if (!on) return "";
    return on.mine ? "Your OBS" : `${displayName(props.profiles.get(on.by), "Someone")}'s OBS`;
  };
  // OBS's sound comes with its picture automatically. On to start (they put
  // it on for the room); the speaker button on the TV turns it off for you alone.
  // Your own is never played here: you already hear it from your computer.
  const [obsSound, setObsSound] = createSignal(true);
  createEffect(() => {
    const on = obs();
    const audio = on && !on.mine ? on.audio : undefined;
    if (!audio) return;
    const el = audio.attach() as HTMLMediaElement;
    el.hidden = true;
    document.body.append(el);
    createEffect(() => {
      el.muted = !obsSound() || deafened();
    });
    onCleanup(() => {
      audio.detach(el);
      el.remove();
    });
  });
  const [obsVideo, setObsVideo] = createSignal<HTMLVideoElement>();
  createEffect(() => {
    const on = obs();
    const el = obsVideo();
    if (!on || !el) return;
    on.track.attach(el);
    onCleanup(() => on.track.detach(el));
  });

  // play it (and again when the channel changes); nothing plays under OBS
  createEffect(() => {
    const now = obs() ? undefined : playing();
    const el = video();
    setFailed(false);
    if (!now || !el) return;
    const player = playChannel(el, now.url, { muted: true, overlay: false, onFail: () => setFailed(true) });
    // a channel without captions of its own: the strip just stays empty (no message, Kaalob)
    onCleanup(followCaptions(player, setOwnCc));
    // Caption 2: live captions, unless a Room side is showing (the room
    // captions the TV you face there)
    createEffect(() => {
      const box = ccBox();
      if (ccMode() !== 2 || !box || inRoom()) return;
      onCleanup(captionVideo(el, box));
    });
    onCleanup(() => player.destroy());
  });
  createEffect(() => {
    const el = video();
    if (el) el.muted = !sound();
  });

  // on the channel (not OBS): what the captions, the sound and Off belong to
  const onChannel = () => (obs() ? undefined : playing());

  // ---- Pop out (Kaalob): the TV in a small window of its own ---------------
  // The whole TV (the screen, the captions under it, its buttons) moves into a
  // little always-on-top window (the browser's Document Picture-in-Picture),
  // so it can sit anywhere on the screen, over other apps too. Closing that
  // window, or Pop in, puts it back in the sidebar. The same elements are
  // moved, not copied: the picture never stops.
  let tvEl: HTMLDivElement | undefined;
  let awayEl: HTMLDivElement | undefined;
  let popWindow: Window | undefined;
  const [popped, setPopped] = createSignal(false);
  type DocumentPip = { requestWindow: (size: { width: number; height: number }) => Promise<Window> };
  const documentPip = () => (window as unknown as { documentPictureInPicture?: DocumentPip }).documentPictureInPicture;
  function popIn() {
    const win = popWindow;
    popWindow = undefined;
    if (tvEl && awayEl && tvEl.ownerDocument !== document) awayEl.after(tvEl);
    setPopped(false);
    win?.close();
  }
  async function popOut() {
    if (popped()) return popIn();
    const api = documentPip();
    if (!api || !tvEl) {
      // an older browser: its plain picture-in-picture (the picture only, no captions or buttons)
      const el = obs() ? obsVideo() : video();
      void el?.requestPictureInPicture?.().catch(() => {});
      return;
    }
    try {
      const win = await api.requestWindow({ width: 560, height: 380 });
      // the same look there: this page's styles and its theme switches
      for (const node of document.querySelectorAll('style, link[rel="stylesheet"]')) win.document.head.append(node.cloneNode(true));
      for (const [key, value] of Object.entries(document.documentElement.dataset)) if (value !== undefined) win.document.documentElement.dataset[key] = value;
      win.document.title = "Darkwood TV";
      win.document.body.className = "side-tv-window";
      // clicks on its buttons are handled by this page's code
      delegateEvents(["click"], win.document);
      win.document.body.append(tvEl);
      popWindow = win;
      setPopped(true);
      // its own X, or this page going away: back in the sidebar
      win.addEventListener("pagehide", () => {
        if (popWindow === win) popIn();
      });
    } catch {
      /* the browser refused the window: the TV stays where it is */
    }
  }
  onCleanup(popIn);

  // ---- Full screen (Kaalob): the TV over the whole screen ------------------
  // From the sidebar or from its own window (a small window cannot go full
  // screen itself, so the TV comes back to this page first). Esc, or Exit
  // full, ends it.
  const [full, setFull] = createSignal(false);
  const onFullChange = () => setFull(Boolean(tvEl) && document.fullscreenElement === tvEl);
  document.addEventListener("fullscreenchange", onFullChange);
  onCleanup(() => document.removeEventListener("fullscreenchange", onFullChange));
  async function toggleFull() {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
      return;
    }
    if (popped()) popIn();
    await tvEl?.requestFullscreen().catch(() => {});
  }
  /** The channel list opens in this page: over the whole screen it would be hidden behind the TV. */
  async function openList() {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    setPicking(true);
  }

  return (
    <>
    {/* where the TV sits in the sidebar while it is in its own window */}
    <div class="side-tv side-tv-away" ref={awayEl} hidden={!popped()}>
      <span>The TV is in its own window.</span>
      <button type="button" class="btn" onClick={popIn}>
        Bring it back
      </button>
    </div>
    <div class="side-tv" ref={tvEl} classList={{ off: !playing() && !obs(), "cc-on": Boolean(onChannel()) && ccMode() !== 0, popped: popped() || full() }}>
      <button
        type="button"
        class="side-tv-screen"
        title={sharing() ? "Click to choose a channel for everyone" : "Click to choose a channel"}
        aria-label={obs() ? `TV: ${obsName()}. Choose a channel` : playing() ? `TV: ${playing()!.name}. Choose a channel` : "TV is off. Choose a channel"}
        onClick={() => void openList()}
      >
        <Show
          when={obs()}
          fallback={
            <Show
              when={playing()}
              fallback={
                <span class="side-tv-off">
                  <b>TV</b>
                  <small>Click to choose a channel</small>
                </span>
              }
            >
              <video ref={setVideo} autoplay playsinline muted />
              <Show when={failed()}>
                <span class="side-tv-failed">This channel can't play here</span>
              </Show>
            </Show>
          }
        >
          {/* someone's OBS, straight from the call: it takes over the screen */}
          <video ref={setObsVideo} autoplay playsinline muted />
        </Show>
      </button>
      {/* captions: under the screen, never on the picture, two lines at a time */}
      <Show when={onChannel() && ccMode() !== 0}>
        <div class="side-tv-cc">
          <Show when={ccMode() === 1 && ownCc()}>
            <span class="side-tv-cc-own">{ownCc()}</span>
          </Show>
          <div class="live-cc" ref={setCcBox} hidden />
        </div>
      </Show>
      <Show when={obs() ? obsName() : playing()?.name}>{(name) => <span class="side-tv-name">{name()}</span>}</Show>
      <Show when={onChannel()}>
        <button
          type="button"
          class="icon-btn side-tv-sound"
          aria-pressed={sound()}
          aria-label={sound() ? "Mute the TV" : "Turn the TV sound on"}
          title={sound() ? "Mute (only for you)" : "Sound on (only for you)"}
          onClick={() => setSound((s) => !s)}
        >
          {sound() ? "🔊" : "🔇"}
        </button>
      </Show>
      {/* someone's OBS with sound: the speaker turns it off or on, for you alone */}
      <Show when={obs() && !obs()!.mine && obs()!.sound}>
        <button
          type="button"
          class="icon-btn side-tv-sound"
          aria-pressed={obsSound()}
          aria-label={obsSound() ? "Mute the TV" : "Turn the TV sound on"}
          title={obsSound() ? "Mute (only for you)" : "Sound on (only for you)"}
          onClick={() => setObsSound((s) => !s)}
        >
          {obsSound() ? "🔊" : "🔇"}
        </button>
      </Show>
      {/* over the screen while the pointer is on the TV: CC, OBS, and Off (or Hide) */}
      <div class="side-tv-tools">
        <Show when={onChannel()}>
          <CcButton mode={ccMode()} onNext={nextCc} />
        </Show>
        {/* OBS: put your OBS on this TV for everyone in the videochat, or take it off */}
        <button
          type="button"
          class="side-tv-hide side-tv-obs-btn"
          classList={{ on: Boolean(obs()?.mine) }}
          disabled={!inCall() || tvObsBusy()}
          title={
            !inCall()
              ? "Join this channel's videochat to put OBS on the TV"
              : obs()?.mine
                ? "Take your OBS off the TV"
                : obs()
                  ? "Put your OBS on the TV instead (it takes over)"
                  : "Put your OBS on the TV for everyone here (OBS: Start Virtual Camera first)"
          }
          onClick={() => askTvObs(channelKey())}
        >
          {tvObsBusy() ? "OBS…" : obs()?.mine ? "Stop OBS" : "OBS"}
        </button>
        {/* Full screen: the TV over the whole screen */}
        <Show when={playing() || obs()}>
          <button type="button" class="side-tv-hide" title={full() ? "Leave full screen (Esc)" : "Show the TV over the whole screen"} onClick={() => void toggleFull()}>
            {full() ? "Exit full" : "Full"}
          </button>
        </Show>
        {/* Pop out: the TV in a small window of its own, on top of everything */}
        <Show when={(playing() || obs()) && !full()}>
          <button type="button" class="side-tv-hide" title={popped() ? "Put the TV back in the sidebar" : "Open the TV in its own small window, on top of everything"} onClick={() => void popOut()}>
            {popped() ? "Pop in" : "Pop out"}
          </button>
        </Show>
        <Show when={onChannel()}>
          <Show
            when={picked()}
            fallback={
              <button
                type="button"
                class="side-tv-hide"
                title="Take the room's TV off your side bar (it comes back with the next TV)"
                onClick={() => {
                  const room = shown();
                  if (room) setHidden(keyOf(room));
                }}
              >
                Hide
              </button>
            }
          >
            <button type="button" class="side-tv-hide" title={sharing() ? "Turn the TV off for everyone" : "Turn your TV off"} onClick={() => choose(undefined)}>
              Off
            </button>
          </Show>
        </Show>
      </div>
      {/* over the whole app, not inside the side bar (which slides, and would carry the list with it) */}
      <Show when={picking()}>
        <Portal mount={document.querySelector<HTMLElement>(".shell") ?? document.body}>
          <ChannelPicker open now={playing()?.url} canTurnOff={Boolean(picked())} onPick={choose} onClose={() => setPicking(false)} />
        </Portal>
      </Show>
    </div>
    </>
  );
}

/** The CC button: each click moves on, off -> Caption 1 -> Caption 2 -> off. Its word says where it is now. */
function CcButton(props: { mode: CcMode; onNext: () => void }) {
  const title = () =>
    props.mode === 0
      ? "Captions are off. Click for Caption 1 (the television's own)"
      : props.mode === 1
        ? "Caption 1: the television's own. Click for Caption 2 (live captions)"
        : "Caption 2: live captions made here from the sound. Click to turn captions off";
  return (
    <button type="button" class="side-tv-hide side-tv-cc-btn" classList={{ on: props.mode !== 0 }} aria-label={title()} title={title()} onClick={props.onNext}>
      {props.mode === 0 ? "CC" : `CC ${props.mode}`}
    </button>
  );
}

// more than this in the list: type to narrow it down (the same as the room's own TV list)
const LIST_MAX = 300;
const isUs = (c: TvChannel) => /^(usa|united states)/i.test(c.group);

/**
 * Every channel to choose from: the two playlists as tabs, a search box, and
 * the channels (the USA first; ones that did not play in this browser last,
 * greyed). A click on one puts it on the side TV.
 */
function ChannelPicker(props: {
  open: boolean;
  /** the channel on right now, marked in the list */
  now?: string;
  canTurnOff: boolean;
  onPick: (next: Picked | undefined) => void;
  onClose: () => void;
}) {
  const [source, setSource] = createSignal<string>(SOURCES[0].id);
  const [search, setSearch] = createSignal("");
  // loaded the first time the list is opened, then kept (tv.js keeps each playlist)
  const [channels, { refetch }] = createResource(
    () => (props.open ? source() : undefined),
    (id) => loadChannels(id) as Promise<TvChannel[]>,
  );
  const failed = createMemo(() => (props.open ? (failedChannels() as Set<string>) : new Set<string>()));
  const found = createMemo(() => {
    if (channels.error) return [];
    const q = search().trim().toLowerCase();
    const bad = failed();
    return (channels() ?? [])
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q))
      .sort((a, b) => Number(isUs(b)) - Number(isUs(a)) || Number(bad.has(a.url)) - Number(bad.has(b.url)));
  });
  const close = () => {
    setSearch("");
    props.onClose();
  };
  return (
    <Modal title="TV channels" class="tv-picker" open={props.open} onClose={close}>
      <div class="tv-picker-top">
        <div class="tv-picker-tabs" role="tablist">
          <For each={SOURCES}>
            {(src) => (
              <button type="button" role="tab" aria-selected={source() === src.id} onClick={() => setSource(src.id)}>
                {src.name}
              </button>
            )}
          </For>
        </div>
        <input class="emoji-search" placeholder="Find a channel" value={search()} onInput={(e) => setSearch(e.currentTarget.value)} />
      </div>
      <div class="tv-picker-list">
        <Show when={!channels.error} fallback={
          <p class="tv-picker-note">
            Could not load the channel list.{" "}
            <button class="btn" type="button" onClick={() => void refetch()}>
              Try again
            </button>
          </p>
        }>
          <Show when={!channels.loading} fallback={<p class="tv-picker-note">Loading channels…</p>}>
            <Show when={found().length} fallback={<p class="tv-picker-note">No channel with that name.</p>}>
              <For each={found().slice(0, LIST_MAX)}>
                {(c) => (
                  <button
                    type="button"
                    class="tv-channel"
                    classList={{ now: props.now === c.url, bad: failed().has(c.url) }}
                    onClick={() => {
                      setSearch("");
                      props.onPick({ name: c.name, url: c.url });
                    }}
                  >
                    <Show when={c.logo.startsWith("https://")} fallback={<i aria-hidden="true" />}>
                      <img src={c.logo} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
                    </Show>
                    <span>{c.name}</span>
                    <small>{props.now === c.url ? "On now" : failed().has(c.url) ? `${c.group} · didn't play here` : c.group}</small>
                  </button>
                )}
              </For>
              <Show when={found().length > LIST_MAX}>
                <p class="tv-picker-note">Showing the first {LIST_MAX}. Type a name to find the rest.</p>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
      <div class="modal-actions">
        <Show when={props.canTurnOff}>
          <button class="btn danger" type="button" onClick={() => props.onPick(undefined)}>
            Turn TV off
          </button>
        </Show>
        <button class="btn" type="button" onClick={close}>
          Close
        </button>
      </div>
    </Modal>
  );
}
