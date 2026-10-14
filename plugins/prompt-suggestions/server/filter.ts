const MAX_CHARS = 100;
const MAX_WORDS = 12;
const MIN_WORDS = 2;

/** Single-word replies people really send to a coding agent. */
const SHORT_REPLIES = new Set([
  "yes",
  "yep",
  "sure",
  "ok",
  "okay",
  "continue",
  "proceed",
  "commit",
  "push",
  "deploy",
  "好",
  "好的",
  "可以",
  "继续",
  "提交",
  "推送",
]);

const SENTENCE_BREAK = /[.!?]\s+\S|[。！？]\s*\S/g;
const WRAPPING_TAG = /^<([a-z_-]+)>([\s\S]*)<\/\1>$/i;
const LEADING_LABEL =
  /^(suggestion|suggested (message|prompt|reply)|next message|reply|response|answer|建议|下一句|回复)\s*[:：]\s*/i;
const WRAPPING_QUOTES = /^(["'`“”‘’「」『』])([\s\S]*)\1$|^“([\s\S]*)”$|^「([\s\S]*)」$/;

const REJECTIONS: ReadonlyArray<readonly [string, (text: string, lower: string) => boolean]> = [
  ["no-suggestion", (_, lower) => /^(none|nothing|n\/a|no suggestion|no reply|silence)\b/.test(lower)],
  ["no-suggestion", (text) => /^(无|没有|不需要|暂无)/.test(text)],
  ["multi-line", (text) => /\n/.test(text)],
  ["formatting", (text) => /\*|^[-•#]\s/.test(text)],
  ["too-long", (text) => text.length > MAX_CHARS],
  ["question", (text) => /[?？]$/.test(text)],
  // Two short sentences are a common way to write a follow-up ("Fix it. Nothing else.").
  ["too-many-sentences", (text) => (text.match(SENTENCE_BREAK) ?? []).length > 1],
  ["agent-voice", (_, lower) => /^(i'll|i will|let me|here's|here is|i can|i've)\b/.test(lower)],
  ["agent-voice", (_, lower) => /^(sure|ok|okay)[,!]\s+i\b/.test(lower)],
  ["agent-voice", (text) => /^(我来|我会|我将|好的，我|下面我)/.test(text)],
  [
    "evaluative",
    (_, lower) =>
      /\b(thanks|thank you|looks good|sounds good|great|perfect|nice|awesome|well done)\b/.test(lower),
  ],
  ["evaluative", (text) => /(谢谢|感谢|很好|完美|不错|太棒)/.test(text)],
  ["label", (text) => /^\w+:\s/.test(text)],
];

/**
 * Cleans a raw model reply into one short next prompt, or returns null when the reply is not
 * something the user would plausibly send as-is.
 */
export function normalizeSuggestion(raw: string | null): string | null {
  if (raw === null) return null;
  const text = unwrap(raw.trim());
  if (text.length === 0) return null;
  const lower = text.toLowerCase();
  if (REJECTIONS.some(([, rejects]) => rejects(text, lower))) return null;
  if (!hasSensibleLength(text, lower)) return null;
  return text;
}

function unwrap(text: string): string {
  let current = text;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = current
      .replace(WRAPPING_TAG, (_, __, inner: string) => inner)
      .replace(LEADING_LABEL, "")
      .replace(WRAPPING_QUOTES, (_, __, a?: string, b?: string, c?: string) => a ?? b ?? c ?? "")
      .trim();
    if (next === current) return next;
    current = next;
  }
  return current;
}

function hasSensibleLength(text: string, lower: string): boolean {
  if (text.startsWith("/")) return true;
  const words = countWords(text);
  if (words > MAX_WORDS) return false;
  if (words >= MIN_WORDS) return true;
  return SHORT_REPLIES.has(lower.replace(/[.!。！]$/, ""));
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Word count that also works for Chinese and Japanese, which do not separate words with spaces. */
export function countWords(text: string): number {
  let words = 0;
  for (const segment of segmenter.segment(text)) {
    if (segment.isWordLike) words += 1;
  }
  return words;
}
