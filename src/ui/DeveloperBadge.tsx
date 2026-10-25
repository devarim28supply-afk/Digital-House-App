import { Show } from "solid-js";
import "./developer-badge.css";

/** Display-only recognition, based on account username, never the editable display name. */
export function hasDeveloperBadge(username?: string): boolean {
  const account = username?.trim().toLowerCase();
  return account === "tylr" || account === "operator";
}

export function DeveloperBadge(props: { username?: string }) {
  return <Show when={hasDeveloperBadge(props.username)}><img class="developer-badge" src={`${import.meta.env.BASE_URL}developer-badge.svg`} alt="Developer" title="Digital House developer" width="16" height="16" /></Show>;
}
