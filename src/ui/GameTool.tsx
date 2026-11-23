import { For, type JSX, Show, createSignal } from "solid-js";
import { setUserPrefs, userPrefs } from "../data/prefs";
import "./game-tool.css";

/**
 * The game tools, in the order of the list (the desktop app's, lib/ui/game_tool.dart).
 * The GTA 6 map is gta6map.io here (Kaalob picked it): the desktop app's, gtabase.com,
 * does not let a website show it inside a page.
 */
export const GAME_TOOLS = [
  { id: "gta6", name: "GTA 6 map", url: "https://www.gta6map.io/" },
  { id: "tos", name: "The Other Side ghost chart", url: "https://tos-ghost-chart.vercel.app/" },
  { id: "phasmo", name: "Phasmophobia ghost chart", url: "https://phasmo-ghost-chart.vercel.app/" },
] as const;

/** Which tab of the right sidebar is open: the sidebar as it is, or Game Tool. */
const [rightTab, setRightTab] = createSignal<"main" | "game">("main");
/** Game Tool is open (the tab is picked, and Settings > Gaming Tools is on). */
export const gameToolOpen = () => userPrefs().gameTools && rightTab() === "game";

/** The two tabs at the top of the right sidebar (Kaalob), when Settings > Gaming Tools is on. */
export function RightTabs() {
  return (
    <Show when={userPrefs().gameTools}>
      <div class="right-tabs" role="tablist" aria-label="Right sidebar">
        <button type="button" role="tab" aria-selected={!gameToolOpen()} onClick={() => setRightTab("main")}>
          TV &amp; Chat
        </button>
        <button type="button" role="tab" aria-selected={gameToolOpen()} onClick={() => setRightTab("game")}>
          Game Tool
        </button>
      </div>
    </Show>
  );
}

/**
 * The Game Tool tab: gaming pages, in the app. It covers the sidebar under
 * the two tabs. Its bar has a list to pick the tool from, Reload, and what
 * the sidebar adds (`children`: its size and pin buttons). A tool's page
 * opens the first time it is picked and then stays alive, so coming back to
 * it finds it as you left it.
 */
export function GameTool(props: { children?: JSX.Element }) {
  const tool = () => GAME_TOOLS.find((t) => t.id === userPrefs().gameTool) ?? GAME_TOOLS[0];
  const [opened, setOpened] = createSignal<string[]>([]);
  // each opened tool's page, to load it again (Reload)
  const frames: Record<string, HTMLIFrameElement | undefined> = {};
  const open = () => {
    const id = tool().id;
    if (!opened().includes(id)) setOpened([...opened(), id]);
    return true;
  };

  return (
    <Show when={userPrefs().gameTools && (gameToolOpen() || opened().length > 0)}>
      <section class="game-tool" hidden={!gameToolOpen()} aria-label="Game Tool">
        <Show when={gameToolOpen() && open()}>{null}</Show>
        <header class="game-tool-bar">
          <select aria-label="Pick a game tool" value={tool().id} onChange={(e) => setUserPrefs({ gameTool: e.currentTarget.value })}>
            <For each={GAME_TOOLS}>{(t) => <option value={t.id}>{t.name}</option>}</For>
          </select>
          <button
            type="button"
            class="icon-btn"
            title="Reload"
            aria-label="Reload"
            onClick={() => {
              const frame = frames[tool().id];
              if (frame) frame.src = tool().url;
            }}
          >
            ↻
          </button>
          {props.children}
        </header>
        <div class="game-tool-pages">
          <For each={GAME_TOOLS.filter((t) => opened().includes(t.id))}>
            {(t) => (
              <div class="game-tool-page" hidden={tool().id !== t.id}>
                <iframe ref={(el) => (frames[t.id] = el)} src={t.url} title={t.name} allow="clipboard-write; fullscreen" referrerpolicy="no-referrer" />
              </div>
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}
