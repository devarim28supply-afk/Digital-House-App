import { For, Show, createSignal, onCleanup } from "solid-js";

import { type JoinRequest, approveJoinRequest, declineJoinRequest, watchJoinRequests } from "../data/store";
import "./find-server.css";

/** The people waiting to join this server, with Approve and Decline. For the server's owner and admins. */
export function JoinRequestList(props: { serverId: string; /** banned from this server: their request cannot be approved until they are unbanned */ banned?: string[] }) {
  const [requests, setRequests] = createSignal<JoinRequest[]>([]);
  const [busyUid, setBusyUid] = createSignal("");
  const [error, setError] = createSignal("");

  const stop = watchJoinRequests(props.serverId, setRequests);
  onCleanup(stop);

  async function act(request: JoinRequest, approve: boolean) {
    if (approve && props.banned?.includes(request.uid)) {
      setError(`${request.name} is banned from this server. Unban them first (Server settings, Bans).`);
      return;
    }
    setBusyUid(request.uid);
    setError("");
    try {
      if (approve) await approveJoinRequest(props.serverId, request.uid, request.name);
      else await declineJoinRequest(props.serverId, request.uid, request.name);
    } catch {
      setError(approve ? "Could not approve that request. Try again." : "Could not decline that request. Try again.");
    } finally {
      setBusyUid("");
    }
  }

  return (
    <section class="join-requests" aria-label="Requests to join">
      <h3>Requests to join</h3>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={requests().length} fallback={<p class="find-empty">No one is waiting.</p>}>
        <ul class="srv-list">
          <For each={requests()}>
            {(request) => (
              <li class="find-row">
                <span class="find-name">
                  {request.name}
                  <small>@{request.username}</small>
                </span>
                <button class="btn primary" type="button" disabled={busyUid() === request.uid} onClick={() => void act(request, true)}>
                  Approve
                </button>
                <button class="btn" type="button" disabled={busyUid() === request.uid} onClick={() => void act(request, false)}>
                  Decline
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
