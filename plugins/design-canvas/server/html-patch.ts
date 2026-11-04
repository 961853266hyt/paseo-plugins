/**
 * Edits one element's inline style in a design's HTML source without reformatting anything else.
 * Elements are found by their data-dc-id, which agents give every element worth talking about, so
 * this needs a start-tag scanner rather than a full HTML parser.
 */

export interface Attribute {
  name: string;
  /** The raw value as written, entities and all. */
  value: string;
  quote: '"' | "'" | "";
  /** The whole attribute, name to closing quote. */
  start: number;
  end: number;
}

export interface StartTag {
  name: string;
  start: number;
  /** Just past the closing `>`. */
  end: number;
  selfClosing: boolean;
  attributes: Attribute[];
}

/** Elements whose content is not markup: a `<div` inside a script is not a tag. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"]);
const SPACE = /\s/;

export function scanStartTags(html: string): StartTag[] {
  const tags: StartTag[] = [];
  const lower = html.toLowerCase();
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      i = close < 0 ? n : close + 3;
      continue;
    }
    const next = html[lt + 1] ?? "";
    if (next === "!" || next === "?" || next === "/") {
      const close = html.indexOf(">", lt);
      i = close < 0 ? n : close + 1;
      continue;
    }
    const nameMatch = /^[a-zA-Z][^\s/>]*/.exec(html.slice(lt + 1, lt + 80));
    if (!nameMatch) {
      i = lt + 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    let j = lt + 1 + nameMatch[0].length;
    let selfClosing = false;
    const attributes: Attribute[] = [];
    while (j < n) {
      while (j < n && SPACE.test(html[j]!)) j++;
      if (j >= n) break;
      if (html[j] === ">") {
        j++;
        break;
      }
      if (html[j] === "/") {
        if (html[j + 1] === ">") {
          selfClosing = true;
          j += 2;
          break;
        }
        j++;
        continue;
      }
      const attrStart = j;
      while (j < n && !SPACE.test(html[j]!) && html[j] !== "=" && html[j] !== ">" && !(html[j] === "/" && html[j + 1] === ">")) j++;
      if (j === attrStart) {
        j++;
        continue;
      }
      const attrName = html.slice(attrStart, j).toLowerCase();
      let k = j;
      while (k < n && SPACE.test(html[k]!)) k++;
      let value = "";
      let quote: Attribute["quote"] = "";
      if (html[k] === "=") {
        k++;
        while (k < n && SPACE.test(html[k]!)) k++;
        const q = html[k];
        if (q === '"' || q === "'") {
          const close = html.indexOf(q, k + 1);
          const end = close < 0 ? n : close;
          value = html.slice(k + 1, end);
          quote = q;
          j = Math.min(n, end + 1);
        } else {
          const valueStart = k;
          while (k < n && !SPACE.test(html[k]!) && html[k] !== ">") k++;
          value = html.slice(valueStart, k);
          j = k;
        }
      }
      attributes.push({ name: attrName, value, quote, start: attrStart, end: j });
    }
    tags.push({ name, start: lt, end: j, selfClosing, attributes });
    if (RAW_TEXT.has(name)) {
      const close = lower.indexOf(`</${name}`, j);
      i = close < 0 ? n : close;
    } else {
      i = j;
    }
  }
  return tags;
}

export function findByDcId(html: string, dcId: string): StartTag[] {
  return scanStartTags(html).filter((tag) => tag.attributes.some((attr) => attr.name === "data-dc-id" && attr.value === dcId));
}

/** Splits `a: b; c: url(x;y)` into declarations, keeping semicolons inside parentheses and quotes. */
export function splitDeclarations(style: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const char of style) {
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === ";" && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function propertyOf(declaration: string): string {
  return declaration.slice(0, declaration.indexOf(":")).trim().toLowerCase();
}

/**
 * Sets (or, with an empty value, removes) properties in one tag's style attribute and returns the
 * new HTML. Everything outside that attribute stays byte for byte.
 */
export function setInlineStyle(html: string, tag: StartTag, properties: Readonly<Record<string, string>>): string {
  const style = tag.attributes.find((attr) => attr.name === "style");
  const names = Object.keys(properties).map((name) => name.toLowerCase());
  const kept = (style ? splitDeclarations(style.value) : []).filter((declaration) => !names.includes(propertyOf(declaration)));
  for (const [name, value] of Object.entries(properties)) if (value !== "") kept.push(`${name}: ${value}`);
  const value = kept.join("; ");
  if (style) {
    if (!value) {
      let from = style.start;
      while (from > tag.start && SPACE.test(html[from - 1]!)) from--;
      return html.slice(0, from) + html.slice(style.end);
    }
    const quote = style.quote || '"';
    return `${html.slice(0, style.start)}style=${quote}${value}${quote}${html.slice(style.end)}`;
  }
  if (!value) return html;
  const at = tag.selfClosing ? tag.end - 2 : tag.end - 1;
  return `${html.slice(0, at)} style="${value}"${html.slice(at)}`;
}

// ---- Text --------------------------------------------------------------------------------

/** A tag or comment in the source; the text between tokens is the page's text. */
type Token =
  | { kind: "start"; tag: StartTag }
  | { kind: "end"; name: string; start: number; end: number }
  | { kind: "other"; start: number; end: number };

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** Start tags that close an open element of the same name, as the browser does for `<li>` lists. */
const SELF_NESTING = new Set(["li", "p", "option", "dt", "dd", "tr", "td", "th"]);

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const starts = scanStartTags(html);
  const byStart = new Map(starts.map((tag) => [tag.start, tag]));
  const lower = html.toLowerCase();
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    const tag = byStart.get(lt);
    if (tag) {
      tokens.push({ kind: "start", tag });
      i = tag.end;
      if (RAW_TEXT.has(tag.name)) {
        const close = lower.indexOf(`</${tag.name}`, i);
        if (close < 0) break;
        // The raw content is one opaque token, so it never reads as text of the parent.
        if (close > i) tokens.push({ kind: "other", start: i, end: close });
        i = close;
      }
      continue;
    }
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      const end = close < 0 ? n : close + 3;
      tokens.push({ kind: "other", start: lt, end });
      i = end;
      continue;
    }
    const next = html[lt + 1] ?? "";
    if (next === "/" || next === "!" || next === "?") {
      const close = html.indexOf(">", lt);
      const end = close < 0 ? n : close + 1;
      const name = next === "/" ? /^[a-zA-Z][^\s/>]*/.exec(html.slice(lt + 2, lt + 82))?.[0]?.toLowerCase() : undefined;
      tokens.push(name ? { kind: "end", name, start: lt, end } : { kind: "other", start: lt, end });
      i = end;
      continue;
    }
    // A lone "<" is text.
    i = lt + 1;
  }
  return tokens;
}

interface Children {
  elements: StartTag[];
  /** Runs of text directly inside the element, as [start, end) offsets. */
  texts: Array<{ start: number; end: number }>;
}

/** The direct children of the element whose start tag is `tokens[at]`, or of the whole page when `at` is -1. */
function childrenAt(tokens: Token[], at: number, html: string): Children {
  const parent = at >= 0 ? (tokens[at] as { kind: "start"; tag: StartTag }).tag : null;
  const elements: StartTag[] = [];
  const texts: Array<{ start: number; end: number }> = [];
  const open: string[] = [];
  let cursor = parent ? parent.end : 0;
  const text = (end: number) => {
    if (open.length === 0 && end > cursor) texts.push({ start: cursor, end });
  };
  for (let i = at + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    const start = token.kind === "start" ? token.tag.start : token.start;
    text(start);
    if (token.kind === "start") {
      const { tag } = token;
      if (SELF_NESTING.has(tag.name) && open[open.length - 1] === tag.name) open.pop();
      if (open.length === 0) elements.push(tag);
      if (!VOID.has(tag.name) && !tag.selfClosing) open.push(tag.name);
      cursor = tag.end;
    } else if (token.kind === "end") {
      const depth = open.lastIndexOf(token.name);
      if (depth >= 0) open.length = depth;
      else if (parent && token.name === parent.name) return { elements, texts };
      cursor = token.end;
    } else {
      cursor = token.end;
    }
  }
  if (!parent) text(html.length);
  return { elements, texts };
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«",
  raquo: "»", middot: "·", bull: "•", times: "×", divide: "÷", deg: "°", plusmn: "±", euro: "€",
  pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", thinsp: " ", ensp: " ",
  emsp: " ", zwj: "‍", zwnj: "‌", shy: "­", larr: "←", rarr: "→", uarr: "↑",
  darr: "↓", harr: "↔", check: "✓", star: "☆", hearts: "♥", minus: "−", prime: "′", Prime: "″",
};

/**
 * Decodes a run of source text, remembering where each decoded character came from. A named
 * entity missing from the table above decodes to one character at a position listed in `unknown`.
 */
export function decodeText(source: string): { text: string; offsets: number[]; unknown: number[] } {
  let text = "";
  const offsets: number[] = [];
  const unknown: number[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (char === "\r") {
      // The browser reads CRLF and CR as LF.
      offsets.push(i);
      text += "\n";
      i += source[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (char === "&") {
      const match = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/.exec(source.slice(i, i + 40));
      const decoded = match
        ? match[1] !== undefined
          ? String.fromCodePoint(Math.min(0x10ffff, Number(match[1])))
          : match[2] !== undefined
            ? String.fromCodePoint(Math.min(0x10ffff, parseInt(match[2], 16)))
            : ENTITIES[match[3]!]
        : undefined;
      if (match && decoded !== undefined) {
        for (let k = 0; k < decoded.length; k++) offsets.push(i);
        text += decoded;
        i += match[0].length;
        continue;
      }
      if (match) {
        unknown.push(text.length);
        offsets.push(i);
        text += "\ufffd";
        i += match[0].length;
        continue;
      }
    }
    offsets.push(i);
    text += char;
    i++;
  }
  offsets.push(source.length);
  return { text, offsets, unknown };
}

/** Whether decoded source text reads as `shown`, an unknown entity matching any one character. */
function sameText(decoded: { text: string; unknown: number[] }, shown: string): boolean {
  if (decoded.unknown.length === 0) return decoded.text === shown;
  if (decoded.text.length !== shown.length) return false;
  const wild = new Set(decoded.unknown);
  for (let i = 0; i < shown.length; i++) if (!wild.has(i) && decoded.text[i] !== shown[i]) return false;
  return true;
}

export function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");
}

export interface TextLocation {
  dcId?: string;
  path: readonly number[];
  index: number;
}

/** Why a text edit could not be placed in the source. */
export class TextNotFoundError extends Error {}

/** The [start, end) source range of one text node, found the way the canvas runtime describes it. */
export function findText(html: string, target: TextLocation): { start: number; end: number } {
  const tokens = tokenize(html);
  let at: number;
  if (target.dcId !== undefined) {
    const matches = tokens.flatMap((token, i) =>
      token.kind === "start" && token.tag.attributes.some((attr) => attr.name === "data-dc-id" && attr.value === target.dcId) ? [i] : [],
    );
    if (matches.length === 0) throw new TextNotFoundError(`No element with data-dc-id="${target.dcId}"`);
    if (matches.length > 1) throw new TextNotFoundError(`${matches.length} elements share data-dc-id="${target.dcId}"`);
    at = matches[0]!;
  } else {
    at = tokens.findIndex((token) => token.kind === "start" && token.tag.name === "body");
    if (at < 0) throw new TextNotFoundError("The page has no <body> tag");
  }
  for (const step of target.path) {
    const child = childrenAt(tokens, at, html).elements[step];
    if (!child) throw new TextNotFoundError("The element is not in the page's source");
    at = tokens.findIndex((token) => token.kind === "start" && token.tag === child);
  }
  const run = childrenAt(tokens, at, html).texts[target.index];
  if (!run) throw new TextNotFoundError("The text is not in the page's source");
  return run;
}

/**
 * Replaces one text node's text. Only the changed middle is rewritten, so entities and whitespace
 * around the edit stay as they were. Refuses when the source text is not what the canvas showed.
 */
export function replaceText(html: string, target: TextLocation, before: string, after: string): string {
  const run = findText(html, target);
  const decoded = decodeText(html.slice(run.start, run.end));
  const { offsets } = decoded;
  if (!sameText(decoded, before)) throw new TextNotFoundError("The text in the page's source is not the text on the canvas");
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix++;
  // An entity that decodes to two UTF-16 units is all or nothing: widen the change to whole entities.
  let keepFrom = prefix;
  while (keepFrom > 0 && offsets[keepFrom] === offsets[keepFrom - 1]) keepFrom--;
  let keepTo = before.length - suffix;
  while (keepTo > 0 && keepTo < before.length && offsets[keepTo] === offsets[keepTo - 1]) keepTo++;
  const from = offsets[keepFrom]!;
  const to = offsets[keepTo]!;
  const middle = after.slice(keepFrom, after.length - (before.length - keepTo));
  return html.slice(0, run.start + from) + escapeText(middle) + html.slice(run.start + to);
}
