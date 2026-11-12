import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import {
  type DirectoryEntry,
  cancelJoinRequest,
  hasRequestedJoin,
  requestToJoin,
  watchDirectory,
} from "../data/store";
import { Modal } from "./Modal";
import "./find-server.css";

/**
 * Search the names of the servers in Darkwood Node and ask to join one. Only names are searchable (never channels,
 * members or messages); the server's owner or admins approve from the server's settings.
 */
export function FindServer(props: { uid: string; name: string; username: string; joinedIds: string[]; onDone?: () => void }) {
  const [entries, setEntries] = createSignal<DirectoryEntry[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [search, setSearch] = createSignal("");
  const [requested, setRequested] = createSignal(new Set<string>());
  const [busyId, setBusyId] = createSignal("");
  const [error, setError] = createSignal("");

  const stop = watchDirectory(
    (list) => {
      setEntries(list);
      setLoaded(true);
    },
    () => {
      setFailed(true);
      setLoaded(true);
    },
  );
  onCleanup(stop);

  const shown = createMemo(() => {
    const term = search().trim().toLowerCase();
    return entries()
      .filter((e) => !props.joinedIds.includes(e.id))
      .filter((e) => !term || e.name.toLowerCase().includes(term))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 30);
  });

  // which of the shown servers this person already asked to join (they may read their own request)
  createEffect(() => {
    for (const entry of shown()) {
      if (requested().has(entry.id)) continue;
      void hasRequestedJoin(entry.id, props.uid).then((yes) => {
        if (yes) setRequested((prev) => new Set(prev).add(entry.id));
      });
    }
  });

  async function ask(entry: DirectoryEntry) {
    setBusyId(entry.id);
    setError("");
    try {
      await requestToJoin(entry.id, props.uid, props.name, props.username);
      setRequested((prev) => new Set(prev).add(entry.id));
    } catch {
      setError("Could not send the request. Try again in a moment.");
    } finally {
      setBusyId("");
    }
  }
  async function withdraw(entry: DirectoryEntry) {
    setBusyId(entry.id);
    setError("");
    try {
      await cancelJoinRequest(entry.id, props.uid);
      setRequested((prev) => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
    } catch {
      setError("Could not cancel that request.");
    } finally {
      setBusyId("");
    }
  }

  return (
    <div class="find-server">
      <label class="field">
        <span>Search for a server by name</span>
        <input
          type="search"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
          placeholder="Server name"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          maxLength={60}
        />
      </label>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={failed()}>
        <p class="find-empty">The list of servers could not be loaded. Check your connection and try again.</p>
      </Show>
      <Show when={loaded() && !failed() && !shown().length}>
        <p class="find-empty">{search().trim() ? "No server has that name." : "There are no servers to join yet."}</p>
      </Show>
      <ul class="find-list">
        <For each={shown()}>
          {(entry) => (
            <li class="find-row">
              <span class="find-name">{entry.name}</span>
              <Show
                when={requested().has(entry.id)}
                fallback={
                  <button class="btn primary" type="button" disabled={busyId() === entry.id} onClick={() => void ask(entry)}>
                    Request to join
                  </button>
                }
              >
                <span class="find-sent">Requested</span>
                <button class="btn" type="button" disabled={busyId() === entry.id} onClick={() => void withdraw(entry)}>
                  Cancel
                </button>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <p class="find-hint">An admin of that server approves requests. You will see the server appear here when it does.</p>
    </div>
  );
}

export function FindServerDialog(props: {
  open: boolean;
  uid: string;
  name: string;
  username: string;
  joinedIds: string[];
  onClose: () => void;
}) {
  return (
    <Modal title="Find a server" open={props.open} onClose={props.onClose}>
      <Show when={props.open}>
        <FindServer uid={props.uid} name={props.name} username={props.username} joinedIds={props.joinedIds} onDone={props.onClose} />
      </Show>
    </Modal>
  );
}
