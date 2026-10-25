import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";

import { Room, RoomEvent } from "livekit-client";

import { callFaces } from "../data/callFaces";
import { type Profile } from "../data/store";
import { inRoom } from "../data/where";
import { auth } from "../firebase";
import { autoCaptions } from "../room/livecaptions";
import { playChannel } from "../room/tv";
import { CallStrip, CamRow } from "./CallStrip";

type Tv = { id: number; name: string; url: string; at: number; onAt: number };

/**
 * The first TV turned on in the open tile's Darkwood Room, at the top of the
 * right side bar (Kaalob). Only while a TV is on there; when that one goes
 * off, the next one still on (turned on earliest) takes its place, and a
 * channel change follows along. Muted to start (the speaker is yours alone);
 * a click opens it big over the middle, with the tile's videochat webcams
 * in a row under it, the same as a big screen. Esc or a click on the
 * picture closes it. Hovering
 * shows Hide: it goes from the side bar until that TV is turned off (a
 * different first TV brings it back).
 *
 * The room says which TVs are on in its people's LiveKit attributes
 * (room.js publishTvs); this watches the room unseen (a hidden, watch-only
 * pass), so it works without opening the Room side.
 */
export function SideTv(props: { serverId: string; channelId: string; profiles: Map<string, Profile> }) {
  const [tv, setTv] = createSignal<Tv | undefined>();
  const [sound, setSound] = createSignal(false);
  const [big, setBig] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [video, setVideo] = createSignal<HTMLVideoElement>();
  const [bigVideo, setBigVideo] = createSignal<HTMLVideoElement>();
  // live captions when the channel has no CC (livecaptions.js): on the big
  // view when open, else on the small one unless a Room side is showing
  // (the room captions the TV you face there)
  const [ccBox, setCcBox] = createSignal<HTMLDivElement>();
  const [bigCcBox, setBigCcBox] = createSignal<HTMLDivElement>();
  // Hide: this TV (screen and when it was turned on) stays out of the side bar
  const keyOf = (t: Tv) => `${t.id}|${t.onAt}`;
  const [hidden, setHidden] = createSignal("");
  const shown = () => {
    const now = tv();
    return now && keyOf(now) !== hidden() ? now : undefined;
  };

  // the room, watched unseen
  createEffect(() => {
    const { serverId, channelId } = props;
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

  // play it (and again when the channel changes)
  createEffect(() => {
    const now = shown();
    const el = video();
    setFailed(false);
    if (!now || !el) return;
    const player = playChannel(el, now.url, { muted: true, onFail: () => setFailed(true) });
    createEffect(() => {
      const box = ccBox();
      if (!box || big() || inRoom()) return;
      onCleanup(autoCaptions(el, player, box));
    });
    onCleanup(() => player.destroy());
  });
  createEffect(() => {
    const el = video();
    if (el) el.muted = !sound() || big();
  });
  // big: its own player with your sound setting; Esc closes it
  createEffect(() => {
    const now = shown();
    const el = bigVideo();
    if (!big() || !now || !el) return;
    const player = playChannel(el, now.url, { muted: !sound() });
    const box = bigCcBox();
    const stopCc = box ? autoCaptions(el, player, box) : () => {};
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setBig(false);
    window.addEventListener("keydown", esc);
    onCleanup(() => {
      stopCc();
      player.destroy();
      window.removeEventListener("keydown", esc);
    });
  });
  createEffect(() => {
    if (!shown()) setBig(false);
  });
  // Webcams of the call you are in. Anyone else in this tile's videochat
  // still shows, through the watch-only strip, when you have not joined.
  const callersHere = createMemo(() => {
    const faces = callFaces();
    if (!faces || faces.channelKey !== `${props.serverId}/${props.channelId}`) return undefined;
    return faces.callers;
  });

  return (
    <Show when={shown()}>
      {(now) => (
        <div class="side-tv">
          <button type="button" class="side-tv-screen" title="Click to open it big" aria-label={`TV: ${now().name}`} onClick={() => setBig(true)}>
            <video ref={setVideo} autoplay playsinline muted />
            <Show when={failed()}>
              <span class="side-tv-failed">This channel can't play here</span>
            </Show>
            <div class="live-cc" ref={setCcBox} hidden />
          </button>
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
          <button
            type="button"
            class="side-tv-hide"
            title="Take the TV off your side bar (it comes back with the next TV)"
            onClick={() => setHidden(keyOf(now()))}
          >
            Hide
          </button>
          <Show when={big()}>
            <Portal mount={document.querySelector<HTMLElement>(".main") ?? document.body}>
              <div class="side-tv-big" role="dialog" aria-label={`TV: ${now().name}`} onClick={() => setBig(false)}>
                <div class="side-tv-stage">
                  <video ref={setBigVideo} autoplay playsinline />
                  <div class="live-cc big-cc" ref={setBigCcBox} hidden />
                </div>
                <div class="side-tv-cams" onClick={(e) => e.stopPropagation()}>
                  <Show
                    when={callersHere()}
                    fallback={<CallStrip serverId={props.serverId} channelId={props.channelId} profiles={props.profiles} />}
                  >
                    {(callers) => <CamRow callers={callers()} profiles={props.profiles} />}
                  </Show>
                </div>
              </div>
            </Portal>
          </Show>
        </div>
      )}
    </Show>
  );
}
