import { Match, Switch, createEffect, createSignal, onCleanup } from "solid-js";

import { Login } from "./auth/Login";
import { type AccessState, access } from "./firebase";
import { Shell } from "./ui/Shell";
import { WallView } from "./ui/WallView";

const params = new URLSearchParams(location.search);
// ?wall=living: the Living Room tile's video chat on the 3D room's wall
const WALL_ROOMS: Record<string, string> = { living: "gestr-living" };
const wallRoom = WALL_ROOMS[params.get("wall") ?? ""];

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const PHONE = matchMedia("(pointer: coarse)").matches && !matchMedia("(pointer: fine)").matches;

/**
 * Who you are decides what you see: the login card, the waiting room
 * (registered but not approved yet), or Darkwood Node itself.
 *
 * The front door: on a computer, someone not logged in is sent to the
 * M2A-access bunker (the front page, /), logs in at its terminal, and walks
 * through the blast door back here. Phones get the login card right here.
 * ?login shows the card on a computer too.
 */
export function App() {
  const [state, setState] = createSignal<AccessState>(access.getState() as AccessState);
  const stop = access.onChange((next: AccessState) => setState({ ...next }));
  onCleanup(stop);
  // Firebase restores a saved session a moment after load, then the member
  // record is looked up. Until one of those settles, show nothing rather
  // than flashing the login card at someone who is signed in.
  const [authReady, setAuthReady] = createSignal(false);
  void access.auth.authStateReady().then(() => setAuthReady(true));
  const settled = () => state().status !== "guest" || (authReady() && !access.auth.currentUser);

  // Computers go to the bunker to log in (live site; this PC's dev servers
  // are separate addresses, so the shared login would not carry over).
  const toBunker = () =>
    settled() && state().status === "guest" && !LOCAL && !PHONE && !wallRoom && !params.has("login") && window.top === window;
  createEffect(() => {
    if (toBunker()) location.replace("/");
  });

  const logout = () => void access.logout();

  return (
    <Switch>
      <Match when={!settled() || toBunker()}>{null}</Match>
      <Match when={Boolean(wallRoom) && state().status === "approved" && state().user}>
        {(user) => (
          <WallView uid={user().uid} name={state().member?.name || user().displayName || "Member"} roomKey={wallRoom} />
        )}
      </Match>
      <Match when={state().status === "approved" && state().user}>
        {(user) => (
          <Shell
            uid={user().uid}
            admin={state().admin}
            name={state().member?.name || user().displayName || "Member"}
            username={state().member?.username || ""}
            onLogout={logout}
          />
        )}
      </Match>
      <Match when={state().status === "pending"}>
        <Notice title="Waiting for approval" onLogout={logout}>
          Your account is registered. The operator approves new members; this page opens Darkwood Node on its own
          the moment you are approved.
        </Notice>
      </Match>
      <Match when={state().status === "denied"}>
        <Notice title="Not approved" onLogout={logout}>
          The operator did not approve this account. Ask them if you think that is a mistake.
        </Notice>
      </Match>
      <Match when={state().status === "unregistered"}>
        <Notice title="No membership" onLogout={logout}>
          This login has no member record. Log out and create an account.
        </Notice>
      </Match>
      <Match when={state().status === "error"}>
        <Notice title="Something went wrong" onLogout={logout}>
          {state().error || "The members registry could not be reached."}
        </Notice>
      </Match>
      <Match when={true}>
        <Login />
      </Match>
    </Switch>
  );
}

function Notice(props: { title: string; children: unknown; onLogout: () => void }) {
  return (
    <main class="notice">
      <section class="notice-card">
        <h1>{props.title}</h1>
        <p>{props.children as string}</p>
        <button class="btn" type="button" onClick={props.onLogout}>
          Log out
        </button>
      </section>
    </main>
  );
}
