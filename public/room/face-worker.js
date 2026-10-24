// Finds your face in webcam frames, on its own thread so the room never
// waits for it. Same detector as the bunker's diamond: TensorFlow.js +
// BlazeFace, one face, CPU (workers have no reliable WebGL).
//
// In:  { bitmap, scale }  a small still of the webcam (closed after reading),
//                         scale = webcam pixels per bitmap pixel
// Out: { face }           {centerX, centerY, width, height} in webcam pixels,
//                         or null when no face is sure enough
//      { error }          the detector could not load or run

importScripts(
  "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js",
  "https://cdn.jsdelivr.net/npm/@tensorflow-models/blazeface@0.1.0/dist/blazeface.min.umd.js",
);

const MIN_CONFIDENCE = 0.75;
let loading = null;

function load() {
  loading ??= (async () => {
    await tf.setBackend("cpu");
    await tf.ready();
    return blazeface.load({ maxFaces: 1 });
  })();
  return loading;
}

onmessage = async (e) => {
  const { bitmap, scale } = e.data;
  try {
    const model = await load();
    const faces = await model.estimateFaces(bitmap, false);
    let best = null;
    let bestArea = 0;
    for (const f of faces) {
      const p = Array.isArray(f.probability) ? f.probability[0] : f.probability;
      if (p !== undefined && p < MIN_CONFIDENCE) continue;
      const area = (f.bottomRight[0] - f.topLeft[0]) * (f.bottomRight[1] - f.topLeft[1]);
      if (area > bestArea) { bestArea = area; best = f; }
    }
    let face = null;
    if (best) {
      const [x1, y1] = best.topLeft;
      const [x2, y2] = best.bottomRight;
      face = {
        centerX: ((x1 + x2) / 2) * scale,
        centerY: ((y1 + y2) / 2) * scale,
        width: (x2 - x1) * scale,
        height: (y2 - y1) * scale,
      };
    }
    postMessage({ face });
  } catch (err) {
    loading = null;
    postMessage({ error: err?.message ?? String(err) });
  } finally {
    bitmap.close();
  }
};
