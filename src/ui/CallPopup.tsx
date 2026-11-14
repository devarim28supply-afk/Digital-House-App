import { For, Show, createEffect, onCleanup, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

import { alerts, buzz, dismissAlert, flashTitle, startRing, stopRing } from "../data/alerts";
import "./alerts.css";

export type IncomingCall = {
  /** one ring per person per call */
  key: string;
  serverId: string;
  channelId: string;
  name: string;
  face: JSX.CSSProperties;
  faceText: string;
  /** "calling you" in a DM, "started a call in <where>" in a server */
  line: string;
  ringing: boolean;
};

/**
 * The incoming call popup (big, centered at the top, pulsing so it can be seen from across a room) and the small toast
 * stack under it. Everything shows on screen; the ring tone, tab-title flash and phone buzz come with it.
 */
export function CallPopup(props: { calls: IncomingCall[]; onAnswer: (call: IncomingCall) => void; onDecline: (call: IncomingCall) => void }) {
  createEffect(() => {
    const ringing = props.calls.filter((c) => c.ringing);
    if (!ringing.length) return;
    startRing();
    flashTitle(`Call: ${ringing[0].name}`);
    buzz([400, 200, 400]);
    const again = window.setInterval(() => buzz([400, 200, 400]), 2500);
    onCleanup(() => {
      window.clearInterval(again);
      stopRing();
      flashTitle(null);
    });
  });
  return (
    <Portal>
      <div class="call-popups" role="region" aria-label="Calls and alerts">
        <For each={props.calls}>
          {(call) => (
            <div class="call-popup" classList={{ ringing: call.ringing }} role="alertdialog" aria-label={`${call.name} ${call.line}`}>
              <span class="avatar call-popup-face" style={call.face}>
                {call.faceText}
              </span>
              <div class="call-popup-text">
                <strong>{call.name}</strong>
                <span>{call.line}</span>
              </div>
              <div class="call-popup-actions">
                <button class="btn call-answer" type="button" onClick={() => props.onAnswer(call)}>
                  Join
                </button>
                <button class="btn call-decline" type="button" onClick={() => props.onDecline(call)}>
                  {call.ringing ? "Decline" : "Dismiss"}
                </button>
              </div>
            </div>
          )}
        </For>
        <For each={alerts()}>
          {(a) => (
            <div class="alert-toast" role="status" aria-live="polite">
              <button
                class="alert-body"
                type="button"
                onClick={() => {
                  a.onClick?.();
                  dismissAlert(a.id);
                }}
              >
                <strong>{a.title}</strong>
                <span>{a.detail}</span>
              </button>
              <button class="alert-close" type="button" aria-label="Dismiss" onClick={() => dismissAlert(a.id)}>
                ×
              </button>
            </div>
          )}
        </For>
      </div>
    </Portal>
  );
}
