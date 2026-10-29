import { Show, createEffect, createResource, createSignal, on, onCleanup } from "solid-js";

import { callFaces } from "../data/callFaces";
import { type Channel, type Profile, hasDarkwoodRoom, imageSrc, operationSessionUrl, roomCamOf, roomUrlOf } from "../data/store";
import { setInRoom, watchRequest } from "../data/where";
import { CallStrip, CamRow } from "./CallStrip";
import { VoiceRoom } from "./VoiceRoom";

type Pane = "video" | "room";
/**
 * The Videochat/Room toggle itself lives in Shell.tsx's header now (same row
 * as the title, Feedback and Dashboard) - this is how it reaches in to drive
 * the actual pane, since that state (and everything switching it touches:
 * the operation bunker's camera, localStorage, the room page loading) stays
 * owned here, not duplicated in Shell.
 */
export type RoomPaneToggle = {
  pane: () => Pane;
  show: (next: Pane) => void;
  /** Room is reachable at all: a url exists (or, the Operation Room, not on a phone) */
  canRoom: () => boolean;
  /** "Videochat"/"Room" normally, "Window"/"Room" for the Operation Room */
  labels: { video: string; room: string };
};
const paneKey = (cid: string) => `dh_pane_${cid}`;

function recallPane(cid: string): Pane {
  try {
    return localStorage.getItem(paneKey(cid)) === "room" ? "room" : "video";
  } catch {
    return "video";
  }
}

/**
 * A picture tile opened: the room's video chat, and a toggle that flips the
 * same pane to the room page. Both stay alive underneath, so looking at the
 * room does not hang up the call and coming back does not reload the room.
 * The tile's room is one fixed room (store GESTR_ROOMS), the same for all.
 */
export function RoomPane(props: {
  serverId: string;
  channel: Channel;
  uid: string;
  name: string;
  username: string;
  profiles: Map<string, Profile>;
  /** teamed-up streamers here: one rotating screen per team */
  teams?: string[][];
  /** Disconnect pressed: the app ends this call (and with it the room) */
  onLeave: () => void;
  /** Shell's header renders the actual Videochat/Room buttons from this */
  onToggle?: (t: RoomPaneToggle | undefined) => void;
}) {
  const phoneQuery = window.matchMedia("(max-width:600px)");
  const [phone, setPhone] = createSignal(phoneQuery.matches);
  const phoneChanged = () => setPhone(phoneQuery.matches);
  phoneQuery.addEventListener("change",phoneChanged);
  onCleanup(() => phoneQuery.removeEventListener("change",phoneChanged));
  const [pane, setPane] = createSignal<Pane>(phone() ? "video" : recallPane(props.channel.id));
  createEffect(() => {if(phone() && pane() !== "video") setPane("video");});
  // The room page loads the first time it is shown, then stays loaded.
  const [roomLoaded, setRoomLoaded] = createSignal(pane() === "room");

  const operation = () => props.channel.roomKey === "m2a-operation";
  // One bunker page for the whole visit. Window and Room only tell that
  // page which camera to use, so the src never changes and nobody drops.
  const operationSrc = operationSessionUrl(props.serverId, props.channel.id, pane() === "room" ? "room" : "window");
  const operationOrigin = new URL(operationSrc, location.href).origin;
  let operationFrame: HTMLIFrameElement | undefined;
  const tellOperation = (view: "window" | "room") =>
    operationFrame?.contentWindow?.postMessage({ type: "dh-operation-view", view }, operationOrigin);
  // One camera: this call already has it. The bunker must not open a second
  // one, or the device goes black for everyone else. Frames of this person's
  // camera are handed to that page for the hex plate.
  let operationCamGen = 0;
  createEffect(on(
    () => {
      if (!operation()) return undefined;
      const faces = callFaces();
      if (!faces || faces.channelKey !== `${props.serverId}/${props.channel.id}`) return undefined;
      return faces.callers.find((c) => c.identity === props.uid)?.video;
    },
    (stream) => {
      const gen = ++operationCamGen;
      const send = (data: Record<string, unknown>, transfer?: Transferable[]) =>
        operationFrame?.contentWindow?.postMessage({ gen, ...data }, operationOrigin, transfer ?? []);
      if (!stream) {
        send({ type: "dh-operation-cam", on: false });
        return;
      }
      const video = document.createElement("video");
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
      video.srcObject = stream;
      document.body.appendChild(video);
      video.play().catch(() => {});
      let alive = true;
      let busy = false;
      const pump = () => {
        if (!alive) return;
        window.setTimeout(async () => {
          if (!alive) return;
          const win = operationFrame?.contentWindow;
          if (!busy && win && video.readyState >= 2 && video.videoWidth > 0) {
            busy = true;
            try {
              const frame = await createImageBitmap(video);
              if (!alive || !operationFrame?.contentWindow) frame.close();
              else send({ type: "dh-operation-frame", frame }, [frame]);
            } catch {
              /* this frame missed; the next one still goes */
            }
            busy = false;
          }
          if (alive) pump();
        }, 80);
      };
      pump();
      onCleanup(() => {
        alive = false;
        send({ type: "dh-operation-cam", on: false, gen: ++operationCamGen });
        video.srcObject = null;
        video.remove();
      });
    },
  ));
  // Looking at the room: the Online list says "In <room>".
  // The Operation Room is always that window, so it counts the whole time.
  createEffect(() => {
    if (!operation() && pane() !== "room") return;
    setInRoom(props.channel.name);
    onCleanup(() => setInRoom(undefined));
  });

  createEffect(
    on(
      () => props.channel.id,
      (cid) => {
        const next = recallPane(cid);
        setPane(next);
        setRoomLoaded(next === "room");
      },
      { defer: true },
    ),
  );

  // A LIVE tile was clicked: the stream is in the videochat, so show it.
  createEffect(() => {
    if (watchRequest() && pane() !== "video") show("video");
  });

  // The room page captions the TV you face only while you can see it: tell
  // it when the videochat covers it (and when it loads).
  let frame: HTMLIFrameElement | undefined;
  const tellRoom = () => frame?.contentWindow?.postMessage({ type: "dh-pane", shown: pane() === "room" }, location.origin);
  createEffect(() => {
    pane();
    tellRoom();
  });

  function show(next: Pane) {
    if (phone() && next === "room") return;
    setPane(next);
    if (next === "room") setRoomLoaded(true);
    if (operation()) tellOperation(next === "room" ? "room" : "window");
    try {
      localStorage.setItem(paneKey(props.channel.id), next);
    } catch {
      /* private mode */
    }
  }

  const url = () => roomUrlOf(props.channel, props.serverId);
  const canRoom = () => (operation() ? !phone() : Boolean(url()));
  createEffect(() => {
    props.onToggle?.({
      pane,
      show,
      canRoom,
      labels: operation() ? { video: "Window", room: "Room" } : { video: "Videochat", room: "Room" },
    });
  });
  onCleanup(() => props.onToggle?.(undefined));
  // A Darkwood Room is loaded for everyone in the tile, even on the videochat
  // side (hidden, and idle: it draws, tracks and plays nothing while hidden).
  // Then the room's TV keeps running for whoever is still in the tile when
  // the person who turned it on leaves: the loaded rooms carry it.
  createEffect(() => {
    if (url() && hasDarkwoodRoom(props.channel)) setRoomLoaded(true);
  });
  // A tile linking to someone else's site: some sites refuse to be shown
  // inside another page. The server reads the site's rules; a refusing site
  // gets an "Open it in its own tab" button instead. Our own pages (the
  // Darkwood Room, and White Torture served from here) always fit.
  const [embeddable] = createResource(
    () => {
      const link = props.channel.roomKey ? undefined : url() || undefined;
      if (!link || link.startsWith("/")) return undefined;
      return link;
    },
    async (link) => {
      try {
        const res = await fetch(`/api/frame-check?url=${encodeURIComponent(link)}`);
        return res.ok ? Boolean(((await res.json()) as { embeddable?: boolean }).embeddable) : true;
      } catch {
        return true;
      }
    },
  );
  const blocked = () => embeddable() === false;
  // Last time this tile showed its room, but it has none now: the videochat.
  createEffect(() => {
    if (pane() === "room" && !url()) setPane("video");
  });
  // the 3D room's live camera, as the Room view in this videochat
  // (none while the tile has no room attached, and none from the Darkwood
  // Room, which has no room camera)
  const roomView = () => {
    const cam = url() && !hasDarkwoodRoom(props.channel) && !operation() ? roomCamOf(props.channel) : null;
    return cam ? { ...cam, username: props.username } : undefined;
  };
  const operationCallers = () => {
    const faces = callFaces();
    if (!faces || faces.channelKey !== `${props.serverId}/${props.channel.id}`) return [];
    return faces.callers;
  };

  return (
    <Show
      when={operation()}
      fallback={
    <div class="room-pane">
      <div class="pane-layer" classList={{ hidden: pane() !== "video" }}>
        <VoiceRoom
          serverId={props.serverId}
          channel={props.channel}
          uid={props.uid}
          name={props.name}
          profiles={props.profiles}
          roomView={roomView()}
          teams={props.teams}
          autoJoin
          seats={hasDarkwoodRoom(props.channel)}
          onLeave={props.onLeave}
        />
      </div>

      <div class="pane-layer room-layer" classList={{ hidden: pane() !== "room" }}>
        <Show when={roomLoaded() && url() && !blocked()}>
          <iframe
            ref={frame}
            onLoad={tellRoom}
            src={url()!}
            title={`${props.channel.name} room`}
            allow="camera; microphone; fullscreen; display-capture; autoplay; pointer-lock; xr-spatial-tracking"
          />
        </Show>
        {/* the tile's videochat as small screens over the bottom of the page
            (the Darkwood Room shows its own, inside room.html) */}
        <Show when={pane() === "room" && url() && !blocked() && !hasDarkwoodRoom(props.channel)}>
          <CallStrip serverId={props.serverId} channelId={props.channel.id} profiles={props.profiles} />
        </Show>
        <Show when={blocked()}>
          <div class="room-blocked">
            <img src={imageSrc(props.channel.image)} alt="" />
            <p>
              <b>{props.channel.name}</b> can't open inside Darkwood Node (its site does not allow it).
            </p>
            <button class="btn primary" type="button" onClick={() => window.open(url()!, "_blank", "noopener")}>
              Open {props.channel.name} ↗
            </button>
            <small>The videochat and the chat here keep going.</small>
          </div>
        </Show>
      </div>
    </div>
      }
    >
      <div class="room-pane operation" classList={{ "in-room": pane() === "room" }}>
        <div class="operation-stage">
          <div class="operation-view">
            <iframe
              ref={operationFrame}
              src={operationSrc}
              onLoad={() => tellOperation(pane() === "room" ? "room" : "window")}
              title={props.channel.name}
              allow="camera; microphone; fullscreen; autoplay; pointer-lock"
            />
          </div>
          <div class="operation-cams">
            <CamRow callers={operationCallers()} profiles={props.profiles} fit />
          </div>
        </div>
        <VoiceRoom
          serverId={props.serverId}
          channel={props.channel}
          uid={props.uid}
          name={props.name}
          profiles={props.profiles}
          teams={props.teams}
          autoJoin
          webcamOnly
          onLeave={props.onLeave}
        />
      </div>
    </Show>
  );
}
