// TV channels for the Darkwood Room monitors.
//
// Channels come from the app's own list, tv-channels.json: free, public
// channels gathered from playlists on GitHub (Free-TV/IPTV and iptv-org),
// sorted into kinds, and every one tried first, so a channel that is gone
// or that other websites may not play is not in it (scripts/tv-channels.mjs
// builds the list; run it again now and then). Every viewer's own browser
// plays the channel straight from its source with hls.js, so it costs
// nobody any upload; only which channel is on travels between people
// (room.js).
//
// Captions: US TV carries closed captions inside the stream (CEA-608);
// hls.js turns them into a text track, which is switched on here.

import Hls from "hls.js";

// The tabs of the channel list: every channel, then one tab per kind.
export const SOURCES = [
  { id: "all", name: "All" },
  ...["News", "Sports", "Movies", "Shows", "Crime", "Comedy", "Reality", "Lifestyle", "Kids", "Music", "Learning", "Spanish", "Faith", "Other"].map((kind) => ({ id: kind, name: kind })),
];

let whole = null; // Promise<channel[]>: the whole list, fetched once

// Channels that would not play in this browser (blocked for other websites,
// gone, or blank): the picker greys them out. A channel that plays again
// is taken off the list.
const FAILED_KEY = "room_tv_failed";
function failedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAILED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function markFailed(url, failed) {
  const set = failedSet();
  if (failed) set.add(url);
  else set.delete(url);
  try {
    localStorage.setItem(FAILED_KEY, JSON.stringify([...set].slice(-500)));
  } catch {
    /* private mode: nothing remembered */
  }
}
export const failedChannels = failedSet;

/** A tab's channels as [{ name, logo, kind, group, url }]; group is where the channel is from. */
export function loadChannels(sourceId) {
  whole ??= fetch(`${import.meta.env.BASE_URL}tv-channels.json`)
    .then((res) => {
      if (!res.ok) throw new Error(`channel list: ${res.status}`);
      return res.json();
    })
    .catch((err) => {
      whole = null; // try again next time
      throw err;
    });
  return whole.then((channels) => (sourceId === "all" ? channels.slice() : channels.filter((c) => c.kind === sourceId)));
}

/**
 * Plays a channel into a <video>, captions on. Returns { destroy }.
 * onFail is called once if the channel will not play here (gone, blocked
 * for other websites, or not available in this country).
 * onCaptions is called once the channel's own captions show a first line
 * (then hasCaptions() is true); a channel without them never calls it.
 * @param {HTMLVideoElement} video
 * @param {string} url
 * overlay: false keeps the channel's captions off the picture; the caller
 * reads them with getCaptionText() and shows them where it wants (the side
 * TV puts them under the screen). The room's TVs leave it on.
 * @param {{ muted?: boolean, overlay?: boolean, onFail?: (why: string) => void, onCaptions?: () => void }} [options]
 */
export function playChannel(video, url, { muted = true, overlay = true, onFail, onCaptions } = {}) {
  let failed = false;
  const fail = (why) => {
    if (failed) return;
    failed = true;
    markFailed(url, true);
    onFail?.(why);
  };
  video.addEventListener("playing", () => markFailed(url, false), { once: true });
  // Closed captions: on by default; a caller can turn them off/on by hand
  // via setCaptions() below. Some channels carry BOTH embedded CEA-608
  // captions and a second, separate WebVTT subtitle track listed in their
  // own playlist for the same line, so only the first one to appear
  // (captionSource) is ever wired up as "the" caption track - without
  // that, both would render on top of each other regardless of setCaptions.
  let captioned = false;
  let captionSource = false;
  let activeTrack = null;
  let ccOn = true;
  // "hidden" still loads the cues (so they can be read), it only does not draw them
  const drawn = () => ccOn && overlay;
  const cueSeen = (e) => {
    if (captioned || !e.target.activeCues?.length) return;
    captioned = true;
    onCaptions?.();
  };
  const showCaptions = () => {
    if (captionSource) return;
    for (const track of video.textTracks) {
      if (track.kind === "captions" || track.kind === "subtitles") {
        captionSource = true;
        activeTrack = track;
        track.mode = drawn() ? "showing" : "hidden";
        track.addEventListener("cuechange", cueSeen);
        return;
      }
    }
  };
  video.textTracks.addEventListener("addtrack", showCaptions);
  video.muted = muted;

  let hls = null;
  if (Hls.isSupported()) {
    hls = new Hls({ enableCEA708Captions: true, renderTextTracksNatively: true, maxBufferLength: 20 });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) fail(data.details || data.type);
    });
    // subtitles listed in the channel's playlist (not inside the video): on
    // too, but only if nothing has claimed captionSource yet (see above).
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
      if (!captionSource && hls.subtitleTracks.length && hls.subtitleTrack < 0) {
        captionSource = true;
        hls.subtitleTrack = 0;
        hls.subtitleDisplay = drawn();
      }
    });
    hls.loadSource(url);
    hls.attachMedia(video);
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url; // Safari plays HLS itself
    video.addEventListener("error", () => fail("error"), { once: true });
  } else {
    fail("no HLS here");
  }
  video.play().catch(() => {}); // muted autoplay is always allowed

  return {
    url,
    startedAt: Date.now(),
    hasCaptions: () => captioned,
    ccEnabled: () => ccOn,
    setCaptions(on) {
      ccOn = Boolean(on);
      if (activeTrack) activeTrack.mode = drawn() ? "showing" : "hidden";
      if (hls && hls.subtitleTrack >= 0) hls.subtitleDisplay = drawn();
    },
    /** The line on screen right now, or "". */
    getCaptionText() {
      if (!ccOn) return "";
      // the one caption track, or (subtitles listed in the playlist, which
      // hls.js adds itself) whichever track has a line on right now
      const tracks = activeTrack
        ? [activeTrack]
        : [...video.textTracks].filter((t) => (t.kind === "captions" || t.kind === "subtitles") && t.mode !== "disabled");
      const text = tracks
        .flatMap((t) => [...(t.activeCues ?? [])])
        .map((c) => c.text ?? "")
        .join("\n");
      if (text && !captioned) {
        captioned = true;
        onCaptions?.();
      }
      return text;
    },
    destroy() {
      video.textTracks.removeEventListener("addtrack", showCaptions);
      for (const track of video.textTracks) track.removeEventListener("cuechange", cueSeen);
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
    },
  };
}
