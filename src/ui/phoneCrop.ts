import type { Track, TrackProcessor, VideoProcessorOptions } from "livekit-client";

/**
 * Crops a camera picture to the shape the phone is held in, frame by frame.
 *
 * A picture is never shown inside a tile of the other shape: an upright phone sends a tall 9:16
 * picture, a phone on its side sends a wide 16:9 one. Most phones can be asked for that shape
 * straight from the camera. Some ignore the request and send their own shape. For those, this
 * processor cuts the centre of the picture to the shape wanted, so the picture that leaves the
 * phone always matches the way it is held, and everybody sees the same thing.
 *
 * `getAspect` is read for every frame (width / height), so turning the phone changes the shape on
 * the very next frame without restarting anything.
 */
export const CROP_PROCESSOR_NAME = "phone-crop";

const LONG_SIDE = 1280;

export function createCropProcessor(getAspect: () => number): TrackProcessor<Track.Kind.Video, VideoProcessorOptions> {
  let video: HTMLVideoElement | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let ctx: CanvasRenderingContext2D | null = null;
  let timer = 0;
  let alive = false;

  const outSize = () => {
    const aspect = getAspect();
    const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
    return aspect >= 1 ? { w: LONG_SIDE, h: even(LONG_SIDE / aspect) } : { w: even(LONG_SIDE * aspect), h: LONG_SIDE };
  };

  const drawFrame = () => {
    const v = video;
    const c = canvas;
    if (!alive || !v || !c || !ctx) return;
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (vw > 0 && vh > 0) {
      const { w, h } = outSize();
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      // the biggest centred slice of the picture that has the wanted shape
      const want = w / h;
      let sw = vw;
      let sh = vh;
      if (vw / vh > want) sw = vh * want;
      else sh = vw / want;
      ctx.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, w, h);
    }
    next();
  };

  const next = () => {
    if (!alive || !video) return;
    if (typeof video.requestVideoFrameCallback === "function") video.requestVideoFrameCallback(drawFrame);
    else timer = window.setTimeout(drawFrame, 33);
  };

  const attach = async (source: MediaStreamTrack) => {
    if (!video) return;
    video.srcObject = new MediaStream([source]);
    await video.play().catch(() => undefined);
    next();
  };

  const processor: TrackProcessor<Track.Kind.Video, VideoProcessorOptions> = {
    name: CROP_PROCESSOR_NAME,
    async init(opts) {
      alive = true;
      video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      canvas = document.createElement("canvas");
      const { w, h } = outSize();
      canvas.width = w;
      canvas.height = h;
      ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, w, h);
      }
      processor.processedTrack = canvas.captureStream(30).getVideoTracks()[0];
      await attach(opts.track);
    },
    async restart(opts) {
      // the camera was restarted underneath: same canvas, new source
      window.clearTimeout(timer);
      await attach(opts.track);
    },
    async destroy() {
      alive = false;
      window.clearTimeout(timer);
      if (video) video.srcObject = null;
      processor.processedTrack?.stop();
      processor.processedTrack = undefined;
      video = undefined;
      canvas = undefined;
      ctx = null;
    },
  };
  return processor;
}
