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
      Object.assign(process.env, loadEnv(server.config.mode, __dirname, ["LIVEKIT_"]));
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

export default defineConfig({
  plugins: [apiDev(), solid()],
  build: { target: "es2022" },
});
