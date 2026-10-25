// Live captions for TV channels that have no CC of their own (Kaalob): the
// same on-device engine as Gestr Live Caption (Silero VAD + Moonshine through
// transformers.js, files in public/captions), fed from the TV's own sound.
// Free and private: nothing leaves the browser. English only. The models
// (~60 MB) download once per browser, then come from its cache.
//
// One TV at a time per page (the one you watch): starting captions on
// another TV moves the engine there.

const BASE = `${import.meta.env.BASE_URL}captions/`;
const WAIT_FOR_CC_MS = 15_000; // a channel's own CC gets this long to show up first
const LINE_MS = 7000; // a finished line stays this long

let worker = null; // the engine, in a worker so the room and app stay smooth
let ready = null; // Promise, resolved when the models are loaded
let listener = null; // the session's handler for worker messages
let ctx = null; // AudioContext, made once
let session = null; // the TV being captioned now

function getEngine(onProgress) {
  if (!worker) {
    worker = new Worker(`${BASE}worker.js`, { type: "module" });
    ready = new Promise((resolve, reject) => {
      worker.addEventListener("message", (e) => {
        if (e.data.ready) resolve();
        else if (e.data.error) {
          reject(new Error(e.data.error));
          worker.terminate();
          worker = null; // try again next time
        }
      });
      worker.addEventListener("error", (e) => {
        reject(new Error(e.message || "worker failed"));
        worker?.terminate();
        worker = null;
      });
    });
    worker.addEventListener("message", (e) => listener?.(e.data));
  }
  listener = (m) => {
    if (m.progress != null) onProgress?.(m.progress);
    if (m.interim != null) session?.show(m.interim, false);
    if (m.final) session?.show(m.final, true);
  };
  return ready.then(() => worker);
}

async function getContext() {
  if (!ctx) {
    ctx = new AudioContext();
    await ctx.audioWorklet.addModule(`${BASE}audio-worklet.js`);
    // the browser starts sound paused until you click or press a key once
    const wake = () => void ctx.resume();
    addEventListener("pointerdown", wake, true);
    addEventListener("keydown", wake, true);
  }
  void ctx.resume().catch(() => {});
  return ctx;
}

/** The video's sound as a stream, once it has some. */
function audioOf(video) {
  return new Promise((resolve) => {
    const stream = video.captureStream?.() ?? video.mozCaptureStream?.();
    if (!stream) return resolve(null);
    if (stream.getAudioTracks().length) return resolve(stream);
    stream.addEventListener("addtrack", () => stream.getAudioTracks().length && resolve(stream));
  });
}

/**
 * Live captions for `video` into `box` (an element over it), only if the
 * channel's own CC has not shown up within 15 s; stands down as soon as it
 * does. player: what playChannel returned. Returns stop().
 */
export function autoCaptions(video, player, box) {
  let stopped = false;
  let stopLive = () => {};
  // counted from when the channel started, so looking back at a TV that has
  // played a while captions it straight away
  const wait = Math.max(0, WAIT_FOR_CC_MS - (Date.now() - (player.startedAt ?? Date.now())));
  const timer = setTimeout(() => {
    if (!stopped && !player.hasCaptions()) stopLive = captionVideo(video, box);
  }, wait);
  const ccWatch = setInterval(() => {
    if (player.hasCaptions()) {
      stopLive();
      stopLive = () => {};
    }
  }, 1000);
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(ccWatch);
    stopLive();
  };
}

/** Live captions for `video` into `box` from now on. Returns stop(). */
export function captionVideo(video, box) {
  session?.stop();
  const lines = [];
  let interim = "";
  let clearTimer = 0;
  const render = () => {
    box.replaceChildren(
      ...lines.map((t) => Object.assign(document.createElement("span"), { textContent: t })),
      ...(interim ? [Object.assign(document.createElement("span"), { className: "interim", textContent: interim })] : []),
    );
    box.hidden = !lines.length && !interim;
  };
  const me = {
    stopped: false,
    cleanup: () => {},
    show(text, final) {
      if (me.stopped) return;
      if (final) {
        interim = "";
        lines.push(text);
        while (lines.length > 2) lines.shift();
        clearTimeout(clearTimer);
        clearTimer = setTimeout(() => {
          lines.length = 0;
          render();
        }, LINE_MS);
      } else {
        interim = text;
      }
      render();
    },
    stop() {
      if (me.stopped) return;
      me.stopped = true;
      clearTimeout(clearTimer);
      me.cleanup();
      box.replaceChildren();
      box.hidden = true;
      if (session === me) session = null;
    },
  };
  session = me;
  box.classList.add("live-cc");
  box.hidden = false;
  box.textContent = "Live captions starting…";

  (async () => {
    const engine = await getEngine((percent) => {
      if (session === me) box.textContent = `Live captions loading… ${percent}%`;
    });
    if (me.stopped) return;
    const audio = await getContext();
    const stream = await audioOf(video);
    if (me.stopped) return;
    if (!stream) throw new Error("no sound to caption");
    const source = audio.createMediaStreamSource(stream);
    const down = new AudioWorkletNode(audio, "downsampler");
    const silent = audio.createGain();
    silent.gain.value = 0; // keeps the worklet running without playing the sound twice
    down.port.onmessage = (e) => {
      if (session === me) engine.postMessage({ chunk: e.data }, [e.data.buffer]);
    };
    source.connect(down).connect(silent).connect(audio.destination);
    me.cleanup = () => {
      down.port.onmessage = null;
      source.disconnect();
      down.disconnect();
      silent.disconnect();
    };
    box.textContent = "";
    box.hidden = true;
  })().catch((err) => {
    console.warn("[live captions]", err);
    if (session === me) {
      box.textContent = "Live captions could not start here";
      setTimeout(() => me.stop(), 5000);
    }
  });
  return () => me.stop();
}
