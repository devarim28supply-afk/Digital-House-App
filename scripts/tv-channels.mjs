// Builds public/tv-channels.json: the TV's channel list (src/room/tv.js).
//
//   node scripts/tv-channels.mjs
//
// Free, public channels are gathered from the playlists below, sorted into
// a few kinds (News, Movies, Sports...), and every one is tried the way the
// app's own player (hls.js in a browser) would load it: the playlist, then a
// piece of the video, both of which must answer and must allow another
// website to read them. A channel that does not pass is left out. Channels
// come and go, so run this again now and then and deploy the new list.

import { writeFile } from "node:fs/promises";

const ORIGIN = "https://darkwood-node.vercel.app";
const OUT = new URL("../public/tv-channels.json", import.meta.url);
const LISTS = [
  "https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8",
  "https://iptv-org.github.io/iptv/countries/us.m3u",
  "https://iptv-org.github.io/iptv/languages/eng.m3u",
  // the free streaming services' own channels (the lists above leave most of them out)
  ...Object.keys({ samsung: 1, plex: 1, tubi: 1, roku: 1, xumo: 1, stirr: 1, pluto: 1 }).map((s) => `https://raw.githubusercontent.com/iptv-org/iptv/master/streams/us_${s}.m3u`),
];
// shown with the channel, and found by typing it ("samsung")
const SERVICES = { samsung: "Samsung TV Plus", plex: "Plex", tubi: "Tubi", roku: "The Roku Channel", xumo: "Xumo", stirr: "Stirr", pluto: "Pluto TV" };
const serviceOf = (list) => SERVICES[(list.match(/streams\/us_(\w+)\.m3u$/) || [])[1]] ?? "";
const CHANNEL_INFO = "https://iptv-org.github.io/api/channels.json";
const AT_ONCE = 40;
const WAIT_MS = 12000;

// The kinds shown as tabs (src/room/tv.js lists them in the order shown). A
// channel's own category decides first (KINDS, the first that fits), then
// its name (NAME_HINTS, the first that fits); a general channel is "Shows".
const KINDS = [
  ["News", ["news", "business", "weather"]],
  ["Sports", ["sports", "outdoor", "auto"]],
  ["Movies", ["movies", "classic"]],
  ["Kids", ["kids", "animation", "family"]],
  ["Music", ["music"]],
  ["Learning", ["documentary", "education", "science", "culture"]],
  ["Comedy", ["comedy"]],
  ["Lifestyle", ["lifestyle", "cooking", "travel", "relax", "shop"]],
  ["Faith", ["religious"]],
];
const SHOWS = ["entertainment", "series", "general"];
const NAME_HINTS = [
  ["Spanish", /espa[nñ]ol|telemundo|univision|estrella|novelas?\b|noticias|\bcine\b|latino|\bm[aá]s\b|historia\b|explora|motores|qu[eé] culpa|wapa|todo /i],
  ["News", /\bnews\b|\bcnn\b|\bcnbc\b|bloomberg|weather|\bc-?span\b|newsmax|cheddar|euronews|al jazeera|france 24|\bdw\b|sky news|\bnbc\b|\babc\b|\bcbs\b|\bfox\b|the hill/i],
  ["Sports", /sport|\bespn\b|\bnfl\b|\bnba\b|\bmlb\b|\bnhl\b|golf|tennis|racing|wrestl|\bfight|boxing|poker|fishing|outdoor|soccer|football|\bufc\b|\bwwe\b|nascar|motogp|\bpfl\b|pickleball|surf|grappling|ringside|big 12|team usa|team liquid|meateater|game & fish|jim rome|bensinger|equus|torque|hagerty|top gear|road renegades/i],
  ["Kids", /kids|cartoon|toon|junior|\bjr\b|baby|babies|nick|anime|pok[eé]mon|blippi|barbie|sonic|hot wheels|strawberry shortcake|slugterra|lego|batterypop|dinos|hunter x hunter|jojo|sensical|lassie/i],
  ["Music", /music|\bmtv\b|vevo|radio|hits|karaoke|concert|stingray|xite|k ?pop|billboard|vinyl|trace uk/i],
  ["Crime", /crime|murder|killer|mystery|mysteries|court|justice|\bpd\b|first 48|forensic|cheaters|caught on tape|cops|48 hours|medical examiner|witness|unsolved|repo|hitchcock|nash bridges|21 jump street|silent witness|cults/i],
  ["Movies", /movie|cinema|film|western|horror|thriller|miramax|universal (action|monsters)|cinevault|hi-yah|national lampoon|haunt/i],
  ["Comedy", /comedy|comedies|funny|laugh|conan|\bafv\b|smosh|mythical|hot ones|try guys|saved by the bell|the conners|leave it to beaver|dhar mann|mr\.? ?beast/i],
  ["Reality", /reality|housewives|vault|pawn stars|storage wars|duck dynasty|swamp people|hoarders|intervention|60 days in|dance moms|bring it|project runway|little women|ice road|ax men|mountain men|forged in fire|oak island|bondi rescue|i survived|masked singer|got talent|family feud|price is right|let's make a deal|supermarket sweep|game show|buzzr|nosey|matched married|weddings|million dollar|flipping|tiny house|kitchen nightmares|untold stories|top chef/i],
  ["Lifestyle", /food|cook|kitchen|chef|tastemade|tasty|emeril|jamie oliver|rachael ray|martha stewart|gusto|garden|home|house|property|reno|craft|bob ross|travel|vibes|fireplace|pets?\b|dog|omstars|jewelry|shop|deal zone|tony robbins|my money|sorry ?girls/i],
  ["Learning", /docu|history|science|nature|nasa|discovery|\bted\b|learn|animal|planet|ancient aliens|unxplained|curiosity|pbs|biography|military|wilderness|jack hanna|mark rober|xplore|universe|paranormal|american stories/i],
  ["Faith", /church|gospel|faith|christ|catholic|islam|quran|bible|\btbn\b|prayer|ministr|god\b/i],
];
const NOT_FOR_HERE = /xxx|adult|porn|erotic|playboy|\b18\+/i;

const headers = { Origin: ORIGIN, Referer: ORIGIN + "/", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" };

async function get(url, { text = true } = {}) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), WAIT_MS);
  try {
    const res = await fetch(url, { headers, signal: stop.signal, redirect: "follow" });
    if (!res.ok) throw new Error(String(res.status));
    // another website (this app) must be allowed to read it, or hls.js gets nothing
    const allow = res.headers.get("access-control-allow-origin");
    if (allow !== "*" && allow !== ORIGIN) throw new Error("closed to other websites");
    if (text) return { body: await res.text(), url: res.url };
    // a piece of video: the first bytes are enough
    const reader = res.body.getReader();
    const { value } = await reader.read();
    await reader.cancel().catch(() => {});
    if (!value?.length) throw new Error("empty");
    return { body: "", url: res.url };
  } finally {
    clearTimeout(timer);
  }
}

/** Throws unless the channel would play: playlist, then one piece of its video. */
async function tryChannel(url) {
  let list = await get(url);
  if (!list.body.trimStart().startsWith("#EXTM3U")) throw new Error("not a playlist");
  if (list.body.includes("#EXT-X-STREAM-INF")) {
    // a list of qualities: take the first one
    const lines = list.body.split(/\r?\n/);
    const at = lines.findIndex((l) => l.startsWith("#EXT-X-STREAM-INF"));
    const next = lines.slice(at + 1).find((l) => l.trim() && !l.startsWith("#"));
    if (!next) throw new Error("no quality listed");
    list = await get(new URL(next.trim(), list.url).href);
  }
  // locked video (FairPlay, Widevine) cannot be played by this player
  if (/#EXT-X-KEY:.*METHOD=SAMPLE-AES/i.test(list.body) || /skd:\/\//i.test(list.body)) throw new Error("locked");
  const pieces = list.body.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  if (!pieces.length) throw new Error("no video listed");
  await get(new URL(pieces[pieces.length - 1].trim(), list.url).href, { text: false });
}

function parse(text) {
  const lines = text.split(/\r?\n/);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const info = lines[i];
    if (!info.startsWith("#EXTINF")) continue;
    let url = "";
    let needsMore = false;
    for (let j = i + 1; j < lines.length && !url; j++) {
      if (lines[j].startsWith("#EXTINF")) break;
      // a channel that wants its own referrer or browser name: a web page cannot send those
      if (lines[j].startsWith("#EXTVLCOPT") || lines[j].startsWith("#KODIPROP")) needsMore = true;
      else if (lines[j] && !lines[j].startsWith("#")) url = lines[j].trim();
    }
    if (needsMore || !/^https:\/\/.+\.m3u8(\?|$)/i.test(url)) continue;
    const attr = (key) => (info.match(new RegExp(`${key}="([^"]*)"`)) || [])[1] || "";
    // "CNN (720p) [Geo-blocked]" -> "CNN"
    const name = info
      .slice(info.lastIndexOf(",") + 1)
      .replace(/\s*[\[(][^\])]*[\])]/g, "")
      .replace(/\s*[ⓈⓢⒼⓖ]\s*/g, " ")
      .trim();
    if (!name) continue;
    found.push({ name, logo: attr("tvg-logo"), id: attr("tvg-id").replace(/@.*$/, ""), group: attr("group-title"), url });
  }
  return found;
}

function kindOf(channel, info) {
  const cats = [...(info.get(channel.id)?.categories ?? []), ...channel.group.toLowerCase().split(";")].map((c) => c.trim());
  for (const [kind, words] of KINDS) if (cats.some((c) => words.includes(c))) return kind;
  for (const [kind, hint] of NAME_HINTS) if (hint.test(channel.name)) return kind;
  // a general channel, or a streaming service's channel nobody has sorted: most of them are shows
  return cats.some((c) => SHOWS.includes(c)) || serviceOf(channel.from) ? "Shows" : "Other";
}

const info = new Map();
try {
  for (const c of await (await fetch(CHANNEL_INFO)).json()) info.set(c.id, c);
} catch {
  console.log("no channel info: sorting by name only");
}

const byUrl = new Map();
for (const list of LISTS) {
  const res = await fetch(list);
  if (!res.ok) throw new Error(`${list}: ${res.status}`);
  for (const c of parse(await res.text())) if (!byUrl.has(c.url)) byUrl.set(c.url, { ...c, from: list });
}
const all = [...byUrl.values()].filter((c) => {
  const known = info.get(c.id);
  return !known?.is_nsfw && !known?.categories?.includes("xxx") && !NOT_FOR_HERE.test(c.name) && !NOT_FOR_HERE.test(c.group);
});
console.log(all.length, "channels to try");

const good = [];
const why = new Map();
let next = 0;
let done = 0;
await Promise.all(
  Array.from({ length: AT_ONCE }, async () => {
    while (next < all.length) {
      const c = all[next++];
      try {
        await tryChannel(c.url);
        good.push(c);
      } catch (err) {
        const reason = err.name === "AbortError" ? "no answer" : /^\d+$/.test(err.message) ? "gone or blocked" : err.message.startsWith("closed") || ["locked", "not a playlist", "no video listed", "no quality listed", "empty"].includes(err.message) ? err.message : "no answer";
        why.set(reason, (why.get(reason) ?? 0) + 1);
      }
      if (++done % 200 === 0) console.log(done, "tried,", good.length, "play");
    }
  }),
);

// where a channel is from: the USA first in every list, then other English
// speaking places, then the rest of the world
const placeName = new Intl.DisplayNames(["en"], { type: "region" });
const ENGLISH = ["GB", "UK", "CA", "AU", "IE", "NZ"];
function placeOf(c) {
  const code = (info.get(c.id)?.country ?? (c.id.match(/\.([a-z]{2})$/i) || [])[1] ?? "").toUpperCase();
  let name = "";
  try {
    name = code ? placeName.of(code === "UK" ? "GB" : code) : "";
  } catch {
    /* an unknown code */
  }
  const service = serviceOf(c.from);
  if (service) return { name: `United States · ${service}`, rank: 0 };
  if (!name && c.from.includes("Free-TV")) name = c.group;
  if (!name && c.from.endsWith("/us.m3u")) name = "United States";
  if (name === "USA") name = "United States";
  const us = code === "US" || name === "United States";
  const english = ENGLISH.includes(code) || /^(uk|united kingdom|canada|australia|ireland|new zealand)$/i.test(name) || (!code && c.from.endsWith("/eng.m3u"));
  return { name, rank: us ? 0 : english ? 1 : 2 };
}
for (const c of good) c.place = placeOf(c);

// one of each name (the same channel is often listed more than once)
const seen = new Set();
const out = [];
for (const c of good.sort((a, b) => a.place.rank - b.place.rank || a.name.localeCompare(b.name))) {
  const key = c.name.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  out.push({ name: c.name, logo: c.logo.startsWith("https://") ? c.logo : info.get(c.id)?.logo ?? "", kind: kindOf(c, info), group: c.place.name, url: c.url });
}
await writeFile(OUT, JSON.stringify(out));
const count = {};
for (const c of out) count[c.kind] = (count[c.kind] ?? 0) + 1;
console.log("from the USA", out.filter((c) => c.group.startsWith("United States")).length);
for (const service of Object.values(SERVICES)) console.log(service, out.filter((c) => c.group.endsWith(service)).length);
console.log("kept", out.length, count);
console.log("left out", Object.fromEntries(why));
