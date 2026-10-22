import { type JSX, Show, onCleanup, onMount } from "solid-js";

/**
 * A small in-page dialog (never the browser's prompt/confirm).
 * Esc or a click on the backdrop closes it.
 */
export function Modal(props: { title: string; open: boolean; onClose: () => void; children: JSX.Element }) {
  return (
    <Show when={props.open}>
      <ModalBody {...props} />
    </Show>
  );
}

function ModalBody(props: { title: string; onClose: () => void; children: JSX.Element }) {
  let panel: HTMLDivElement | undefined;
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
  onMount(() => {
    window.addEventListener("keydown", onKey);
    panel?.querySelector<HTMLElement>("input, textarea, button")?.focus();
  });
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="modal" role="dialog" aria-modal="true" aria-label={props.title} ref={panel}>
        <header class="modal-head">
          <h2>{props.title}</h2>
          <button class="icon-btn" type="button" aria-label="Close" onClick={props.onClose}>
            ✕
          </button>
        </header>
        {props.children}
      </div>
    </div>
  );
}
