// TV channels for the Darkwood Room monitors.
//
// Channels come from public playlists on GitHub: Free-TV/IPTV (hand-picked
// free, legal channels, the default) and iptv-org (many more US channels,
// less reliable). Every viewer's own browser plays the channel straight
// from its source with hls.js, so it costs nobody any upload; only which
// channel is on travels between people (room.js).
//
// Captions: US TV carries closed captions inside the stream (CEA-608);
// hls.js turns them into a text track, which is switched on here.

import Hls from "hls.js";

export const SOURCES = [
  { id: "free", name: "Free TV", url: "https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8" },
  { id: "more", name: "More channels (US)", url: "https://iptv-org.github.io/iptv/countries/us.m3u" },
];

const lists = new Map(); // source id -> Promise<channel[]>

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

/** A playlist as [{ name, logo, group, url }], only streams a browser can play. */
export function loadChannels(sourceId) {
  if (!lists.has(sourceId)) {
    const source = SOURCES.find((s) => s.id === sourceId);
    lists.set(
      sourceId,
      fetch(source.url)
        .then((res) => {
          if (!res.ok) throw new Error(`channel list: ${res.status}`);
          return res.text();
        })
        .then(parseM3u)
        .catch((err) => {
          lists.delete(sourceId); // try again next time
          throw err;
        }),
    );
  }
  return lists.get(sourceId);
}

function parseM3u(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  for (let i = 0; i < lines.length; i++) {
    const info = lines[i];
    if (!info.startsWith("#EXTINF")) continue;
    // the stream address is the next line that is not another # line
    let url = "";
    for (let j = i + 1; j < lines.length && !url; j++) {
      if (lines[j] && !lines[j].startsWith("#")) url = lines[j].trim();
      else if (lines[j].startsWith("#EXTINF")) break;
    }
    // HLS only: YouTube pages and other kinds do not play in a <video>
    if (!/^https:\/\/.+\.m3u8(\?|$)/i.test(url)) continue;
    const attr = (key) => (info.match(new RegExp(`${key}="([^"]*)"`)) || [])[1] || "";
    const name = info.slice(info.lastIndexOf(",") + 1).trim();
    if (!name) continue;
    channels.push({ name, logo: attr("tvg-logo"), group: attr("group-title") || "Other", url });
  }
  return channels;
}

/**
 * Plays a channel into a <video>, captions on. Returns { destroy }.
 * onFail is called once if the channel will not play here (gone, blocked
 * for other websites, or not available in this country).
 * onCaptions is called once the channel's own captions show a first line
 * (then hasCaptions() is true); a channel without them never calls it.
 * @param {HTMLVideoElement} video
 * @param {string} url
 * @param {{ muted?: boolean, onFail?: (why: string) => void, onCaptions?: () => void }} [options]
 */
export function playChannel(video, url, { muted = true, onFail, onCaptions } = {}) {
  let failed = false;
  const fail = (why) => {
    if (failed) return;
    failed = true;
    markFailed(url, true);
    onFail?.(why);
  };
  video.addEventListener("playing", () => markFailed(url, false), { once: true });
  // closed captions: show the first captions/subtitles track that appears,
  // and say so the first time one of its lines shows (live captions stand down)
  let captioned = false;
  const cueSeen = (e) => {
    if (captioned || !e.target.activeCues?.length) return;
    captioned = true;
    onCaptions?.();
  };
  const showCaptions = () => {
    for (const track of video.textTracks) {
      if (track.kind === "captions" || track.kind === "subtitles") {
        track.mode = "showing";
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
    // subtitles listed in the channel's playlist (not inside the video): on too
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
      if (hls.subtitleTracks.length && hls.subtitleTrack < 0) {
        hls.subtitleTrack = 0;
        hls.subtitleDisplay = true;
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
    destroy() {
      video.textTracks.removeEventListener("addtrack", showCaptions);
      for (const track of video.textTracks) track.removeEventListener("cuechange", cueSeen);
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
    },
  };
}
