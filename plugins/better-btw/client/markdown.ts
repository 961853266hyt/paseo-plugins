/**
 * Just enough Markdown for chat answers: Paseo gives plugins no Markdown renderer. Parsing never
 * fails, and a half-streamed answer (an unclosed code fence, say) still reads sensibly.
 */

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** Set on link text; only http and https links are kept. */
  url?: string;
}

export interface ListItem {
  depth: number;
  /** "•" for bullets, or the item's own number such as "2.". */
  marker: string;
  lines: string[];
}

export type Block =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; text: string }
  | { kind: "list"; items: ListItem[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "table"; lines: string[] }
  | { kind: "rule" };

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;

export function parseMarkdown(markdown: string): Block[] {
  const blocks: Block[] = [];
  // A fence closes on a run of its own character at least as long as the one that opened it.
  let fence: { marker: string; lines: string[] } | null = null;
  // The open block that the next plain line continues, if any.
  let open: Block | null = null;

  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence) {
      if (closesFence(line, fence.marker)) {
        blocks.push({ kind: "code", text: fence.lines.join("\n") });
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    const fenceStart = FENCE.exec(line);
    if (fenceStart) {
      fence = { marker: fenceStart[1]!, lines: [] };
      open = null;
      continue;
    }
    if (line.trim() === "") {
      open = null;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      blocks.push({ kind: "heading", level, text: headingText(heading[2]!) });
      open = null;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      open = null;
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      if (open?.kind === "quote") open.lines.push(quote[1]!);
      else blocks.push((open = { kind: "quote", lines: [quote[1]!] }));
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const marker = /^\d/.test(item[2]!) ? item[2]!.replace(")", ".") : "•";
      const depth = Math.floor(item[1]!.replace(/\t/g, "  ").length / 2);
      const next: ListItem = { depth, marker, lines: [item[3]!] };
      if (open?.kind === "list") open.items.push(next);
      else blocks.push((open = { kind: "list", items: [next] }));
      continue;
    }
    if (TABLE_ROW.test(line)) {
      if (open?.kind === "table") open.lines.push(line.trim());
      else blocks.push((open = { kind: "table", lines: [line.trim()] }));
      continue;
    }
    // A plain line continues the open paragraph, list item or quote; otherwise it starts a paragraph.
    if (open?.kind === "paragraph" || open?.kind === "quote") open.lines.push(line.trim());
    else if (open?.kind === "list") open.items.at(-1)!.lines.push(line.trim());
    else blocks.push((open = { kind: "paragraph", lines: [line.trim()] }));
  }
  if (fence) blocks.push({ kind: "code", text: fence.lines.join("\n") });
  return blocks;
}

function closesFence(line: string, marker: string): boolean {
  const run = line.trim();
  return run.length >= marker.length && [...run].every((char) => char === marker[0]);
}

/** Drops a closing run of `#`s, which counts only after a space, so "C#" keeps its `#`. */
function headingText(text: string): string {
  const trimmed = text.trimEnd();
  let end = trimmed.length;
  while (end > 0 && trimmed[end - 1] === "#") end -= 1;
  if (end === trimmed.length || (end > 0 && !/\s/.test(trimmed[end - 1]!))) return trimmed;
  return trimmed.slice(0, end).trimEnd();
}

/**
 * Code first, so nothing inside backticks is read as emphasis; `_` emphasis needs word boundaries
 * so snake_case names stay intact. No lookbehind, which older Hermes builds lack.
 */
const INLINE =
  /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+?)\*\*|\b__([^_\n]+?)__\b|\*([^*\s][^*\n]*?)\*|\b_([^_\n]+?)_\b/g;

export function parseInline(text: string, inherited: Omit<Span, "text"> = {}): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) spans.push({ ...inherited, text: text.slice(last, start) });
    const [whole, code, linkText, url, bold, boldAlt, italic, italicAlt] = match;
    if (code !== undefined) spans.push({ ...inherited, text: code, code: true });
    else if (linkText !== undefined) {
      const safe = /^https?:\/\//i.test(url ?? "") ? url : undefined;
      spans.push(...parseInline(linkText, safe ? { ...inherited, url: safe } : inherited));
    } else if (bold !== undefined || boldAlt !== undefined) {
      spans.push(...parseInline(bold ?? boldAlt ?? "", { ...inherited, bold: true }));
    } else if (italic !== undefined || italicAlt !== undefined) {
      spans.push(...parseInline(italic ?? italicAlt ?? "", { ...inherited, italic: true }));
    } else {
      spans.push({ ...inherited, text: whole });
    }
    last = start + whole.length;
  }
  if (last < text.length) spans.push({ ...inherited, text: text.slice(last) });
  return spans;
}
