import { Show, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import "./developer-badge.css";

/** Display-only recognition, based on account username, never the editable display name. */
export function hasDeveloperBadge(username?: string): boolean {
  const account = username?.trim().toLowerCase();
  return account === "tylr" || account === "operator";
}

export function DeveloperBadge(props: { username?: string }) {
  const [tooltip, setTooltip] = createSignal<{ x: number; y: number }>();

  function showTooltip(event: FocusEvent | MouseEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setTooltip({ x: rect.left + rect.width / 2, y: rect.top - 8 });
  }

  return (
    <Show when={hasDeveloperBadge(props.username)}>
      <span
        class="developer-badge-wrap"
        role="img"
        aria-label="Developer of Sector Null (Since 26')"
        tabIndex={0}
        onMouseEnter={showTooltip}
        onMouseLeave={() => setTooltip(undefined)}
        onFocus={showTooltip}
        onBlur={() => setTooltip(undefined)}
      >
        <img class="developer-badge" src={`${import.meta.env.BASE_URL}developer-badge.svg`} alt="" width="16" height="16" />
        <i class="badge-sparkle sparkle-one" aria-hidden="true" />
        <i class="badge-sparkle sparkle-two" aria-hidden="true" />
        <i class="badge-sparkle sparkle-three" aria-hidden="true" />
        <Show when={tooltip()}>
          {(pos) => (
            <Portal>
              <span class="developer-badge-tooltip" role="tooltip" style={{ left: `${pos().x}px`, top: `${pos().y}px` }}>
                Developer of Sector Null (Since 26')
              </span>
            </Portal>
          )}
        </Show>
      </span>
    </Show>
  );
}
