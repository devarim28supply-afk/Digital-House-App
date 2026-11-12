import { Match, Switch, createEffect, createSignal, onCleanup } from "solid-js";

import { DhGate } from "./auth/DhGate";
import { FaceOffer } from "./auth/FaceOffer";
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
 * The front door is the login card, on phones and computers alike (the
 * M2A-access bunker is no longer the front page).
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

  const logout = () => void access.logout();

  return (
    <Switch>
      <Match when={!settled()}>{null}</Match>
      <Match when={Boolean(wallRoom) && state().status === "approved" && state().user}>
        {(user) => (
          <WallView
            uid={user().uid}
            name={state().member?.name || user().displayName || "Member"}
            username={state().member?.username || ""}
            roomKey={wallRoom}
          />
        )}
      </Match>
      <Match when={state().status === "approved" && state().user}>
        {(user) => (
          <>
            <Shell
              uid={user().uid}
              admin={state().admin}
              staff={state().staff}
              developer={Boolean(state().member?.roles?.develop)}
              name={state().member?.name || user().displayName || "Member"}
              username={state().member?.username || ""}
              onLogout={logout}
            />
            <FaceOffer />
          </>
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
      <Match when={state().status === "suspended"}>
        <Notice title="Account suspended" onLogout={logout}>
          A staff member has suspended this account. Ask them if you think that is a mistake.
        </Notice>
      </Match>
      <Match when={state().status === "banned"}>
        <Notice title="Account banned" onLogout={logout}>
          A staff member has banned this account.
        </Notice>
      </Match>
      {/* an open sign-up account (real email, no operator approval): verify the email, then Darkwood Node */}
      <Match when={state().status === "unregistered" && state().user}>
        {(user) => (
          <DhGate>
            {(member) => (
              <>
                <Shell
                  uid={user().uid}
                  admin={false}
                  staff={false}
                  developer={false}
                  name={member.name}
                  username={member.username}
                  onLogout={logout}
                />
                <FaceOffer />
              </>
            )}
          </DhGate>
        )}
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
