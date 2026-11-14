import { For, type JSX } from "solid-js";

import { ACCESS_DEFAULTS, type Access, access, resetAccess, setAccess } from "../data/access";
import { Modal } from "./Modal";
import "./accessibility.css";

/**
 * Accessibility (Kaalob: the whole thing, like Discord's Accessibility and
 * Appearance pages): text size and spacing, zoom, cozy or compact messages,
 * colors and contrast, links, motion, animated pictures, the Send button,
 * and the sidebars' sizes. Every change shows at once and is kept in this
 * browser (data/access.ts); the chat sample in the dialog shows the chat
 * settings as you move them.
 */
export function AccessibilityDialog(props: { open: boolean; onClose: () => void }) {
  const a = access;
  const changed = () => JSON.stringify(a()) !== JSON.stringify(ACCESS_DEFAULTS);

  /** A slider with its value beside it, Discord-style. */
  const Slider = (p: { label: string; hint: string; value: number; min: number; max: number; step: number; unit: string; onChange: (n: number) => void }) => (
    <label class="access-row">
      <b>{p.label}</b>
      <span class="access-slider">
        <input type="range" min={p.min} max={p.max} step={p.step} value={p.value} onInput={(e) => p.onChange(Number(e.currentTarget.value))} />
        <output>
          {p.value}
          {p.unit}
        </output>
      </span>
      <small>{p.hint}</small>
    </label>
  );
  /** A few named choices, one picked. */
  function Choices<K extends keyof Access>(p: { label: string; hint?: string; field: K; options: { value: Access[K]; label: string }[] }): JSX.Element {
    return (
      <div class="access-row" role="group" aria-label={p.label}>
        <b>{p.label}</b>
        <div class="access-choices">
          <For each={p.options}>
            {(o) => (
              <button type="button" aria-pressed={a()[p.field] === o.value} onClick={() => setAccess({ [p.field]: o.value } as Partial<Access>)}>
                {o.label}
              </button>
            )}
          </For>
        </div>
        {p.hint ? <small>{p.hint}</small> : null}
      </div>
    );
  }
  /** On or off. */
  const Toggle = (p: { label: string; hint: string; value: boolean; onChange: (on: boolean) => void }) => (
    <label class="access-toggle">
      <span>
        <b>{p.label}</b>
        <small>{p.hint}</small>
      </span>
      <input type="checkbox" checked={p.value} onChange={(e) => p.onChange(e.currentTarget.checked)} />
    </label>
  );

  return (
    <Modal title="Accessibility" class="access" open={props.open} onClose={props.onClose}>
      <div class="access-scroll">
        <fieldset class="access-group">
          <legend>Chat text</legend>
          {/* the chat, as these settings make it look */}
          <div class="access-sample chat" aria-hidden="true">
            <article class="msg">
              <span class="avatar avatar-btn" style={{ background: "#4ade80" }}>
                K
              </span>
              <div class="msg-body">
                <header class="msg-head">
                  <b class="msg-author">Kaalob</b>
                  <time>Today at 2:14 PM</time>
                </header>
                <p class="msg-text">Movie night is on Friday.</p>
              </div>
            </article>
            <article class="msg grouped">
              <div class="msg-body">
                <p class="msg-text">
                  Bring <strong>snacks</strong>. <a>See the plan</a>
                </p>
              </div>
            </article>
            <article class="msg">
              <span class="avatar avatar-btn" style={{ background: "#60a5fa" }}>
                T
              </span>
              <div class="msg-body">
                <header class="msg-head">
                  <b class="msg-author">Ty</b>
                  <time>Today at 2:20 PM</time>
                </header>
                <p class="msg-text">I'm in!</p>
              </div>
            </article>
          </div>
          <Slider label="Chat font scaling" hint="The size of the text in messages and in the message box." value={a().chatSize} min={12} max={24} step={1} unit="px" onChange={(n) => setAccess({ chatSize: n })} />
          <Slider label="Space between message groups" hint="The gap above a message from a new person, or after a pause." value={a().groupGap} min={0} max={24} step={2} unit="px" onChange={(n) => setAccess({ groupGap: n })} />
          <Choices
            label="Message display"
            field="display"
            options={[
              { value: "cozy", label: "Cozy" },
              { value: "compact", label: "Compact" },
            ]}
            hint="Cozy: pictures of people, roomy. Compact: no pictures, time and name on the message's own line, so more fits."
          />
          <p class="access-note">
            Formatting works in every message: **bold**, *italic*, __underline__, ~~strike~~, `code`, ```code block```, ||spoiler||, &gt; quote, # heading, - list.
          </p>
        </fieldset>

        <fieldset class="access-group">
          <legend>Size</legend>
          <Slider label="Zoom level" hint="Everything in the app bigger or smaller: text, buttons, pictures. On a computer." value={a().zoom} min={50} max={200} step={10} unit="%" onChange={(n) => setAccess({ zoom: n })} />
          <div class="access-row">
            <b>Sidebar sizes</b>
            <small>Drag the inner edge of the left or the right sidebar to make it as wide as you like. Double-click the edge to put it back.</small>
            <div class="access-choices">
              <button type="button" disabled={!a().leftWidth && !a().rightWidth} onClick={() => setAccess({ leftWidth: 0, rightWidth: 0 })}>
                Put both sidebars back to normal
              </button>
            </div>
          </div>
        </fieldset>

        <fieldset class="access-group">
          <legend>Color and contrast</legend>
          <Slider label="Saturation" hint="How strong the app's colors are. 0% is grey. Webcams, the TV and photos are not changed." value={a().saturation} min={0} max={100} step={5} unit="%" onChange={(n) => setAccess({ saturation: n })} />
          <Choices
            label="Contrast"
            field="contrast"
            options={[
              { value: "normal", label: "Normal" },
              { value: "high", label: "High" },
            ]}
            hint="High: brighter text, stronger lines and thicker outlines, in dark and in light mode."
          />
          <Toggle label="Always underline links" hint="Links are underlined, not told apart by color alone." value={a().underlineLinks} onChange={(on) => setAccess({ underlineLinks: on })} />
        </fieldset>

        <fieldset class="access-group">
          <legend>Motion</legend>
          <Choices
            label="Reduced motion"
            field="motion"
            options={[
              { value: "auto", label: "Same as my computer" },
              { value: "reduce", label: "Reduce" },
              { value: "full", label: "Full motion" },
            ]}
            hint="Reduce: sidebars, dialogs and highlights appear at once instead of sliding, fading or pulsing."
          />
          <Choices
            label="GIFs, animated emojis and stickers in chat"
            field="animations"
            options={[
              { value: "always", label: "Always play" },
              { value: "hover", label: "Play under the pointer" },
              { value: "never", label: "Never play" },
            ]}
            hint="Kept still, a moving picture shows its first frame. Click a picture to open it and see it move."
          />
        </fieldset>

        <fieldset class="access-group">
          <legend>Message box</legend>
          <Toggle label="Show the Send button" hint="Enter always sends a message; Shift+Enter makes a new line. The button is for sending with a click." value={a().sendButton} onChange={(on) => setAccess({ sendButton: on })} />
        </fieldset>
      </div>
      <div class="modal-actions">
        <button class="btn danger" type="button" disabled={!changed()} onClick={() => resetAccess()}>
          Reset everything
        </button>
        <button class="btn primary" type="button" onClick={props.onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
