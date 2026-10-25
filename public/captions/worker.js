// Live captions engine off the page (a module worker), so the 3D room and the
// app stay smooth while Moonshine works. The page sends 16 kHz frames of
// 512 samples ({ chunk }); this sends back { progress } while loading, then
// { ready }, and { interim } / { final } text.
import * as T from "./transformers.min.js";
import { createCaptioner } from "./captioner.js";

T.env.allowLocalModels = false;
T.env.useBrowserCache = true;
T.env.backends.onnx.wasm.wasmPaths = new URL("./", import.meta.url).href;

const captioner = createCaptioner(T, {
  device: "wasm",
  model: "base",
  onProgress: (p) => {
    if (p?.status === "progress" && p.file?.endsWith(".onnx")) postMessage({ progress: Math.round(p.progress ?? 0) });
  },
  onInterim: (text) => postMessage({ interim: text }),
  onFinal: (text) => postMessage({ final: text }),
});
captioner.then(() => postMessage({ ready: true }), (err) => postMessage({ error: String(err?.message ?? err) }));

onmessage = async (e) => {
  if (e.data?.chunk) (await captioner).push(e.data.chunk);
};
