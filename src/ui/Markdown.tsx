import { For, type JSX, Show, createSignal } from "solid-js";

/**
 * Message formatting, the way Discord writes it (Kaalob):
 *
 *   **bold**   *italic* or _italic_   __underline__   ~~strike~~
 *   `code`     ```a block of code```   ||spoiler||
 *   > quote    # Heading, ## Heading, ### Heading    - item, * item, 1. item
 *
 * Nothing is parsed as HTML: the text is cut into pieces here and each piece
 * becomes its own element. The plain runs in between are handed back to the
 * chat (props.plain), which is what turns links, :emojis: and @mentions into
 * what they are, so those keep working inside bold, quotes and the rest.
 * Links are cut out first, so an address with * or _ in it stays whole.
 */

type Inline =
  | { t: "text"; v: string }
  | { t: "link"; v: string }
  | { t: "code"; v: string }
  | { t: "b" | "i" | "u" | "s" | "spoiler"; c: Inline[] };

type Block =
  | { t: "line"; c: Inline[]; last: boolean }
  | { t: "quote"; c: Inline[] }
  | { t: "h"; level: 1 | 2 | 3; c: Inline[] }
  | { t: "item"; n?: string; c: Inline[] }
  | { t: "pre"; v: string };

const URL_RE = /(https?:\/\/[^\s<]+)/g;
// one mark at a time, the longest marks first: `code`, **bold**, __underline__,
// ~~strike~~, ||spoiler||, *italic*, _italic_ (not inside a word: snake_case stays)
const MARK =
  /(`+)([^`\n]+?)\1|\*\*([^\n]+?)\*\*|__([^\n]+?)__|~~([^\n]+?)~~|\|\|([^\n]+?)\|\||\*([^*\n]+?)\*|(?<![A-Za-z0-9_])_([^_\n]+?)_(?![A-Za-z0-9_])/;

/** One line's text as pieces: links whole, then the marks, the rest plain. */
function inline(text: string): Inline[] {
  const out: Inline[] = [];
  const parts = text.split(URL_RE);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) out.push({ t: "link", v: parts[i] });
    else out.push(...marks(parts[i]));
  }
  return out;
}
function marks(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  while (rest) {
    const m = MARK.exec(rest);
    if (!m) break;
    if (m.index) out.push({ t: "text", v: rest.slice(0, m.index) });
    if (m[2] !== undefined) out.push({ t: "code", v: m[2] });
    else if (m[3] !== undefined) out.push({ t: "b", c: marks(m[3]) });
    else if (m[4] !== undefined) out.push({ t: "u", c: marks(m[4]) });
    else if (m[5] !== undefined) out.push({ t: "s", c: marks(m[5]) });
    else if (m[6] !== undefined) out.push({ t: "spoiler", c: marks(m[6]) });
    else out.push({ t: "i", c: marks(m[7] ?? m[8] ?? "") });
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) out.push({ t: "text", v: rest });
  return out;
}

/** The whole message as blocks: code blocks first, then line by line. */
function blocks(text: string): Block[] {
  const out: Block[] = [];
  // ```code```: everything inside is kept exactly as typed
  const fenced = text.split(/```(?:[a-z0-9+#-]*\n)?([\s\S]*?)```/g);
  for (let f = 0; f < fenced.length; f++) {
    if (f % 2 === 1) {
      out.push({ t: "pre", v: fenced[f].replace(/\n$/, "") });
      continue;
    }
    let chunk = fenced[f];
    // the line break right after (or before) a code block is the block's own
    if (f > 0) chunk = chunk.replace(/^\n/, "");
    if (f < fenced.length - 1) chunk = chunk.replace(/\n$/, "");
    if (!chunk && fenced.length > 1) continue;
    const lines = chunk.split("\n");
    lines.forEach((line, i) => {
      const last = i === lines.length - 1;
      let m: RegExpExecArray | null;
      // "> " with its space, as Discord has it: a line like ">:(" is not a quote
      if ((m = /^> (.*)$/.exec(line))) out.push({ t: "quote", c: inline(m[1]) });
      else if ((m = /^(#{1,3}) +(.+)$/.exec(line))) out.push({ t: "h", level: m[1].length as 1 | 2 | 3, c: inline(m[2]) });
      else if ((m = /^\s*[-*] +(.+)$/.exec(line))) out.push({ t: "item", c: inline(m[1]) });
      else if ((m = /^\s*(\d{1,3})\. +(.+)$/.exec(line))) out.push({ t: "item", n: m[1], c: inline(m[2]) });
      else out.push({ t: "line", c: inline(line), last });
    });
  }
  // a plain line needs its line break only when another plain line follows it:
  // quotes, headings, items and code blocks start on their own line by themselves
  for (let i = 0; i < out.length; i++) {
    const b = out[i];
    if (b.t === "line") b.last = i === out.length - 1 || out[i + 1].t !== "line";
  }
  return out;
}

type Leaf = { plain: (text: string) => JSX.Element };

function Spoiler(props: { children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  return (
    <span
      class="md-spoiler"
      classList={{ open: open() }}
      role="button"
      tabindex="0"
      aria-label={open() ? undefined : "Spoiler. Click to show."}
      onClick={() => setOpen(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen(true);
        }
      }}
    >
      <span>{props.children}</span>
    </span>
  );
}

function Pieces(props: { c: Inline[] } & Leaf): JSX.Element {
  return (
    <For each={props.c}>
      {(piece) => {
        switch (piece.t) {
          case "text":
            return props.plain(piece.v);
          case "link":
            return (
              <a href={piece.v} target="_blank" rel="noopener noreferrer">
                {piece.v}
              </a>
            );
          case "code":
            return <code class="md-code">{piece.v}</code>;
          case "b":
            return (
              <strong>
                <Pieces c={piece.c} plain={props.plain} />
              </strong>
            );
          case "i":
            return (
              <em>
                <Pieces c={piece.c} plain={props.plain} />
              </em>
            );
          case "u":
            return (
              <u>
                <Pieces c={piece.c} plain={props.plain} />
              </u>
            );
          case "s":
            return (
              <s>
                <Pieces c={piece.c} plain={props.plain} />
              </s>
            );
          default:
            return (
              <Spoiler>
                <Pieces c={piece.c} plain={props.plain} />
              </Spoiler>
            );
        }
      }}
    </For>
  );
}

/** A message's text, formatted. plain: how the chat draws a run of ordinary text (emojis, @mentions). */
export function Formatted(props: { text: string } & Leaf) {
  return (
    <For each={blocks(props.text)}>
      {(block) => {
        switch (block.t) {
          case "pre":
            return <code class="md-pre">{block.v}</code>;
          case "quote":
            return (
              <span class="md-quote">
                <Pieces c={block.c} plain={props.plain} />
              </span>
            );
          case "h":
            return (
              <span class={`md-h md-h${block.level}`} role="heading" aria-level={block.level + 2}>
                <Pieces c={block.c} plain={props.plain} />
              </span>
            );
          case "item":
            return (
              <span class="md-item" classList={{ numbered: Boolean(block.n) }} data-n={block.n}>
                <Pieces c={block.c} plain={props.plain} />
              </span>
            );
          default:
            return (
              <>
                <Pieces c={block.c} plain={props.plain} />
                <Show when={!block.last}>{"\n"}</Show>
              </>
            );
        }
      }}
    </For>
  );
}
