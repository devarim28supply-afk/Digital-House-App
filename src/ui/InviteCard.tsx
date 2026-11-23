import { Show, createSignal } from "solid-js";
import { acceptInvite, inviteDoor, joinedServerIds, type InviteInfo } from "../data/invites";
import "./invite-card.css";

const letters = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("") || "?";

/**
 * An invite link in a chat, shown as a card like Discord's: the server's
 * banner, its icon and name, how many members, and a button to join it
 * (Kaalob). The same card as the desktop app's (lib/ui/invite_card.dart).
 */
export function InviteCard(props: { code: string; info?: InviteInfo; uid: string; onDone?: () => void }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  /** the server this code turned out to be for, once Accept was clicked */
  const [joinedId, setJoinedId] = createSignal("");
  const sid = () => joinedId() || props.info?.serverId || "";
  const joined = () => !!sid() && (joinedServerIds().has(sid()) || sid() === joinedId());
  const name = () => props.info?.name || "A server";

  async function accept() {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      const id = await acceptInvite(props.uid, props.code);
      setJoinedId(id);
      inviteDoor.open?.(id);
      props.onDone?.();
    } catch (err) {
      const said = err instanceof Error ? err.message : "";
      setError(
        /No server uses that code|8-character/.test(said)
          ? "This invite is not valid any more. Ask for a new one."
          : "Could not join this server. Try again in a moment.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="invite-card">
      <div class="invite-banner">
        <Show when={props.info?.banner}>{(src) => <img src={src()} alt="" loading="lazy" />}</Show>
      </div>
      <div class="invite-icon" aria-hidden="true">
        <Show when={props.info?.icon} fallback={<span>{letters(name())}</span>}>
          {(src) => <img src={src()} alt="" loading="lazy" />}
        </Show>
      </div>
      <div class="invite-body">
        <small class="invite-label">{joined() ? "You are in this server" : "You are invited to join a server"}</small>
        <strong class="invite-name">{name()}</strong>
        <Show when={props.info?.members !== undefined}>
          <span class="invite-members">
            <i aria-hidden="true" />
            {props.info!.members} {props.info!.members === 1 ? "member" : "members"}
          </span>
        </Show>
        <button
          type="button"
          class="invite-accept"
          classList={{ joined: joined() }}
          disabled={busy()}
          onClick={() => {
            if (!joined()) return void accept();
            inviteDoor.open?.(sid());
            props.onDone?.();
          }}
        >
          {busy() ? "Joining…" : joined() ? "Go to server" : "Accept invite"}
        </button>
        <Show when={error()}>
          <p class="invite-error">{error()}</p>
        </Show>
      </div>
    </div>
  );
}
