import { resolve } from "node:path";
import { type Plugin, defineConfig, loadEnv } from "vite";
import solid from "vite-plugin-solid";

/**
 * Dev stand-ins for the Vercel functions in api/ (same handlers).
 * LIVEKIT_* come from .env.local (gitignored).
 */
function apiDev(): Plugin {
  return {
    name: "api-dev",
    apply: "serve",
    configureServer(server) {
      Object.assign(process.env, loadEnv(server.config.mode, __dirname, ["LIVEKIT_", "BLOB_"]));
      server.middlewares.use("/api", async (req, res, next) => {
        const name = (req.url ?? "").split("?")[0].replace(/^\/+/, "");
        if (!/^[a-z-]+$/.test(name)) return next();
        const mod = await server.ssrLoadModule(resolve(__dirname, `api/${name}.ts`)).catch(() => null);
        if (!mod?.default) return next();
        req.url = `/api/${req.url?.replace(/^\/+/, "") ?? ""}`;
        await mod.default(req, res);
      });
    },
  };
}

// Live, the app is /app/ on darkwood-node.vercel.app: the M2A-access bunker
// is the front page at /. Built into dist/app so the files sit under /app/.
// The dev server stays at / (localhost:5186).
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/app/" : "/",
  plugins: [apiDev(), solid()],
  // two pages: the app, and room.html (the Darkwood Room a tile opens)
  build: {
    target: "es2022",
    outDir: "dist/app",
    emptyOutDir: true,
    rollupOptions: { input: { main: resolve(__dirname, "index.html"), room: resolve(__dirname, "room.html") } },
  },
}));
