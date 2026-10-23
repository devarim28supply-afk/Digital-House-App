import { For, Show, createSignal, onCleanup, onMount } from "solid-js";

import { uploadEmoji } from "../data/files";
import { type Emoji, type Sticker, addEmoji, deleteEmoji } from "../data/store";

// The everyday emojis, in Discord-like groups. Server emojis come first.
const STANDARD: { label: string; emojis: string[] }[] = [
  {
    label: "Smileys",
    emojis: [..."😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩😘😗😚😙😋😛😜🤪😝🤑🤗🤭🤫🤔🤐🤨😐😑😶😏😒🙄😬🤥😌😔😪🤤😴😷🤒🤕🤢🤮🥵🥶🥴😵🤯🤠🥳😎🤓🧐😕😟🙁😮😯😲😳🥺😦😧😨😰😥😢😭😱😖😣😞😓😩😫🥱😤😡😠🤬😈👿💀☠💩🤡👹👺👻👽👾🤖"],
  },
  {
    label: "People",
    emojis: [..."👋🤚🖐✋🖖👌🤌🤏✌🤞🤟🤘🤙👈👉👆🖕👇☝👍👎✊👊🤛🤜👏🙌👐🤲🤝🙏✍💅🤳💪🦾👀👁👅👄💋🧠🫀🫁🦷🦴"],
  },
  {
    label: "Hearts",
    emojis: [..."❤🧡💛💚💙💜🖤🤍🤎💔❣💕💞💓💗💖💘💝💟"],
  },
  {
    label: "Animals",
    emojis: [..."🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🙈🙉🙊🐔🐧🐦🐤🦆🦅🦉🦇🐺🐗🐴🦄🐝🐛🦋🐌🐞🐜🕷🐢🐍🦎🐙🦑🦀🐠🐟🐬🐳🦈🐊🐅🐆🦓🦍🐘🦒🐪🦘🐎🐖🐑🐕🐈🐓🦃🦚🦜🦢🐇🐿🦔"],
  },
  {
    label: "Food",
    emojis: [..."🍏🍎🍐🍊🍋🍌🍉🍇🍓🫐🍈🍒🍑🥭🍍🥥🥝🍅🥑🥦🌽🥕🥐🍞🥖🧀🥚🍳🥞🧇🥓🥩🍗🍖🌭🍔🍟🍕🥪🌮🌯🥗🍝🍜🍲🍣🍱🍤🍙🍚🍦🍩🍪🎂🍰🧁🍫🍬🍭🍿☕🍵🥤🧋🍺🍻🥂🍷🥃🍸🍹"],
  },
  {
    label: "Things",
    emojis: [..."⚽🏀🏈⚾🎾🏐🎱🏓🎮🕹🎲🧩🎯🎳🎤🎧🎸🎹🥁🎬🎨📷📸📹🎥📺💻🖥⌨🖱📱☎💡🔦📚📝✏📌📎🔑🔒🔓🔨🛠⚙🧲💣🔫🎁🎈🎉🎊🏆🥇🥈🥉🚗🚕🚙🚌🏎🚓🚑🚒✈🚀🛸⛵🏠🏢🌋🗽🌍🌙⭐🌟✨⚡🔥🌈☀⛅☁🌧⛈❄☃🌊💧"],
  },
  {
    label: "Symbols",
    emojis: [..."✅❌❓❗‼⁉💯🔴🟠🟡🟢🔵🟣⚫⚪🟥🟩🟦⬛⬜▶⏸⏹⏺⏭⏮🔁🔀➕➖✖➗♻⚠🚫⛔💤💢💥💫💬💭🗯🆗🆒🆕🆓🆙"],
  },
].map((g) => ({ ...g, emojis: g.emojis.filter((e) => e.trim() && !/[\u{1F3FB}-\u{1F3FF}]/u.test(e)) }));

/** A server emoji's name, from a file name: lowercase letters, digits, _. */
export function emojiNameFrom(raw: string) {
  return raw
    .replace(/\.[a-z0-9]+$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

/**
 * The 😀 picker above the message box, like Discord's: the server's own
 * emojis (pictures and little GIFs anyone can add) and the everyday ones.
 * Picking puts :name: (or the emoji itself) into the message.
 */
export function EmojiPicker(props: {
  serverId: string;
  uid: string;
  emojis: Emoji[];
  canModerate: boolean;
  onPick: (text: string) => void;
  /** a sticker was picked: it is sent on its own right away */
  onSticker: (sticker: Sticker) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = createSignal<"emoji" | "sticker">("emoji");
  const [search, setSearch] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [name, setName] = createSignal("");
  const [file, setFile] = createSignal<File | undefined>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  let root: HTMLDivElement | undefined;

  // click outside or Esc closes it
  onMount(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (root && t && !root.contains(t) && !t.closest?.(".emoji-btn")) props.onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    onCleanup(() => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    });
  });

  // this tab's own: emojis (no kind, from before stickers) or stickers
  const ofTab = () => props.emojis.filter((e) => (e.kind ?? "emoji") === tab());
  const shown = () => {
    const q = search().trim().toLowerCase();
    return q ? ofTab().filter((e) => e.name.includes(q)) : ofTab();
  };

  async function add(e: SubmitEvent) {
    e.preventDefault();
    const f = file();
    const n = emojiNameFrom(name());
    if (!f) return setError("Choose a picture or a little GIF");
    if (n.length < 2) return setError("Give it a name (2+ letters)");
    if (ofTab().some((x) => x.name === n)) return setError(`"${n}" is taken`);
    setBusy(true);
    setError("");
    try {
      const url = await uploadEmoji(props.serverId, f);
      await addEmoji(props.serverId, { name: n, url, addedBy: props.uid, animated: f.type === "image/gif", kind: tab() });
      setAdding(false);
      setName("");
      setFile(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add that emoji");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="emoji-picker" ref={root} role="dialog" aria-label="Emojis and stickers">
      <div class="emoji-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab() === "emoji"} onClick={() => setTab("emoji")}>
          Emojis
        </button>
        <button type="button" role="tab" aria-selected={tab() === "sticker"} onClick={() => setTab("sticker")}>
          Stickers
        </button>
      </div>
      <div class="emoji-top">
        <input
          class="emoji-search"
          placeholder={tab() === "sticker" ? "Find a sticker" : "Find a server emoji"}
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
        <button type="button" class="side-tool emoji-add" onClick={() => setAdding(!adding())}>
          {adding() ? "Cancel" : tab() === "sticker" ? "+ Add sticker" : "+ Add emoji"}
        </button>
      </div>

      <Show when={adding()}>
        <form class="emoji-form" onSubmit={add}>
          <label class="field">
            <span>Picture or little GIF (up to 2 MB)</span>
            <input
              type="file"
              accept="image/png,image/gif,image/webp,image/jpeg"
              onChange={(e) => {
                const f = e.currentTarget.files?.[0];
                setFile(f);
                if (f && !name()) setName(emojiNameFrom(f.name));
              }}
            />
          </label>
          <label class="field">
            <span>{tab() === "sticker" ? "Sticker name" : "Name (used as :name:)"}</span>
            <input value={name()} maxLength={32} onInput={(e) => setName(e.currentTarget.value)} />
          </label>
          <Show when={error()}>
            <p class="form-error">{error()}</p>
          </Show>
          <button class="btn primary" type="submit" disabled={busy()}>
            {busy() ? "Adding…" : "Add to this server"}
          </button>
        </form>
      </Show>

      <div class="emoji-scroll">
        <div class="emoji-group">{tab() === "sticker" ? "Server stickers" : "Server emojis"}</div>
        <Show
          when={shown().length}
          fallback={<p class="emoji-empty">None yet. Add one with {tab() === "sticker" ? "+ Add sticker" : "+ Add emoji"}.</p>}
        >
          <div class="emoji-grid" classList={{ stickers: tab() === "sticker" }}>
            <For each={shown()}>
              {(emoji) => (
                <span class="emoji-cell">
                  <button
                    type="button"
                    class="emoji-pick"
                    title={tab() === "sticker" ? emoji.name : `:${emoji.name}:`}
                    onClick={() =>
                      tab() === "sticker"
                        ? props.onSticker({ url: emoji.url, name: emoji.name })
                        : props.onPick(`:${emoji.name}:`)
                    }
                  >
                    <img src={emoji.url} alt={`:${emoji.name}:`} loading="lazy" />
                  </button>
                  <Show when={emoji.addedBy === props.uid || props.canModerate}>
                    <button
                      type="button"
                      class="emoji-del"
                      title={`Remove :${emoji.name}:`}
                      aria-label={`Remove :${emoji.name}:`}
                      onClick={() => void deleteEmoji(props.serverId, emoji.id)}
                    >
                      ✕
                    </button>
                  </Show>
                </span>
              )}
            </For>
          </div>
        </Show>
        <Show when={tab() === "emoji" && !search().trim()}>
          <For each={STANDARD}>
            {(group) => (
              <>
                <div class="emoji-group">{group.label}</div>
                <div class="emoji-grid">
                  <For each={group.emojis}>
                    {(emoji) => (
                      <button type="button" class="emoji-pick unicode" onClick={() => props.onPick(emoji)}>
                        {emoji}
                      </button>
                    )}
                  </For>
                </div>
              </>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

/**
 * A chat picture opened big over everything, like Discord: the picture,
 * Open original and Download under it; click outside or Esc to close.
 */
export function ImageViewer(props: { url: string; name: string; onClose: () => void }) {
  const [saving, setSaving] = createSignal(false);
  onMount(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", esc);
    onCleanup(() => window.removeEventListener("keydown", esc));
  });
  // The file lives on another address, so the browser would only open it;
  // fetching it first makes it a real download with its own name.
  async function download() {
    setSaving(true);
    try {
      const blob = await (await fetch(props.url)).blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = props.name || "picture";
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    } catch {
      window.open(props.url, "_blank", "noopener");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div class="viewer" role="dialog" aria-label={props.name} onClick={props.onClose}>
      <figure class="viewer-frame" onClick={(e) => e.stopPropagation()}>
        <img src={props.url} alt={props.name} />
        <figcaption class="viewer-bar">
          <span class="viewer-name">{props.name}</span>
          <a href={props.url} target="_blank" rel="noopener noreferrer">
            Open original
          </a>
          <button type="button" onClick={() => void download()} disabled={saving()}>
            {saving() ? "Saving…" : "Download"}
          </button>
        </figcaption>
      </figure>
      <button type="button" class="viewer-close" aria-label="Close" onClick={props.onClose}>
        ✕
      </button>
    </div>
  );
}
