import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";

export type TimelineItem = PluginLifecycleEvents["agent.turn_ended"]["timeline"][number];
type ToolCall = Extract<TimelineItem, { type: "tool_call" }>;
type ToolDetail = ToolCall["detail"];
type TaskItem = Extract<TimelineItem, { type: "todo" }>["items"][number];

/** About 25,000 to 35,000 tokens of English and code: the size of Paseo's own fork context. */
export const TRANSCRIPT_BUDGET_CHARS = 100_000;
const MAX_MESSAGE_CHARS = 12_000;
const MAX_THINKING_CHARS = 3_000;
const MAX_SUMMARY_CHARS = 300;
const MAX_ERROR_CHARS = 500;
/** Per tool output, so one large file or log cannot crowd out the rest of the session. */
const OUTPUT_CHARS: Record<ToolDetail["type"], number> = {
  read: 6_000,
  write: 3_000,
  edit: 3_000,
  shell: 4_000,
  search: 3_000,
  fetch: 3_000,
  sub_agent: 3_000,
  plan: 4_000,
  plain_text: 2_000,
  worktree_setup: 1_500,
  unknown: 2_000,
};
const SEPARATOR = "\n\n";

export const IN_PROGRESS_OUTPUT =
  "[No result yet: this call is still running, waiting for approval, or queued.]";
export const HISTORY_LEFT_OUT = "[Earlier conversation left out]";
export const DETAIL_LEFT_OUT = "[Some older tool output and thinking is left out to save space.]";

interface Entry {
  /** Kept whenever the entry is kept: messages and one line per tool call. Empty for thinking. */
  text: string;
  /** Tool output or thinking, kept newest first while the budget lasts. */
  extra: string | null;
  role: "user" | "gap" | "other";
}

const GAP: Entry = { text: HISTORY_LEFT_OUT, extra: null, role: "gap" };

export interface TranscriptOptions {
  budgetChars?: number;
  /**
   * Set when only the newer part of the timeline was fetched. The session's first user message,
   * when known, opens the transcript, followed by a note that history was left out.
   */
  olderHistory?: { firstUserMessage: string | null };
}

type Raw =
  | { kind: "user" | "assistant" | "thinking" | "note"; text: string }
  | { kind: "tool"; item: ToolCall }
  | { kind: "tasks"; items: readonly TaskItem[] };

/**
 * The agent's conversation as text for a side question. User and agent messages come first across
 * the whole session; tool output and the agent's thinking then fill what is left of the budget,
 * newest first. When even the messages do not fit, the first user message stays, as it usually
 * states the task.
 */
export function buildTranscript(
  items: readonly TimelineItem[],
  options: TranscriptOptions = {},
): string {
  const budgetChars = options.budgetChars ?? TRANSCRIPT_BUDGET_CHARS;
  let entries = toEntries(items);
  if (options.olderHistory) {
    const first = options.olderHistory.firstUserMessage;
    const opening = first === null ? null : toEntry({ kind: "user", text: first });
    entries = [...(opening ? [opening] : []), GAP, ...entries];
  }
  entries = fitHistory(entries, budgetChars);
  let remaining = budgetChars - entries.reduce((sum, entry) => sum + cost(entry), 0);
  const extras: Array<string | null> = entries.map(() => null);
  let leftOut = false;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const extra = entries[index]!.extra;
    if (extra === null) continue;
    if (extra.length + 1 > remaining) {
      leftOut = true;
      continue;
    }
    extras[index] = extra;
    remaining -= extra.length + 1;
  }
  const parts = entries.flatMap((entry, index) => {
    const part = [entry.text, extras[index]].filter(Boolean).join("\n");
    return part ? [part] : [];
  });
  if (leftOut && parts.length > 0) parts.unshift(DETAIL_LEFT_OUT);
  return parts.join(SEPARATOR);
}

function cost(entry: Entry): number {
  return entry.text.length + SEPARATOR.length;
}

function fitHistory(entries: Entry[], budgetChars: number): Entry[] {
  const total = entries.reduce((sum, entry) => sum + cost(entry), 0);
  if (total <= budgetChars || entries.length === 0) return entries;
  const firstUser = entries.findIndex((entry) => entry.role === "user");
  const head = firstUser === -1 ? [] : [entries[firstUser]!];
  let remaining = budgetChars - head.reduce((sum, entry) => sum + cost(entry), 0) - cost(GAP);
  const tail: Entry[] = [];
  for (let index = entries.length - 1; index > firstUser; index -= 1) {
    const entry = entries[index]!;
    if (entry.role === "gap") continue;
    // The newest entry always stays: it is what a side question asked mid-turn is most likely about.
    if (cost(entry) > remaining && tail.length > 0) break;
    tail.unshift(entry);
    remaining -= cost(entry);
  }
  return [...head, GAP, ...tail];
}

function toEntries(items: readonly TimelineItem[]): Entry[] {
  return collect(items).flatMap((raw) => {
    const entry = toEntry(raw);
    return entry ? [entry] : [];
  });
}

function collect(items: readonly TimelineItem[]): Raw[] {
  const raws: Array<Raw | null> = [];
  const toolIndex = new Map<string, number>();
  let tasksIndex: number | null = null;
  for (const item of items) {
    switch (item.type) {
      case "user_message":
        raws.push({ kind: "user", text: item.text });
        break;
      case "assistant_message":
      case "reasoning": {
        // Streamed text can span several items.
        const kind = item.type === "assistant_message" ? "assistant" : "thinking";
        const previous = raws.at(-1);
        if (previous?.kind === kind) previous.text += item.text;
        else raws.push({ kind, text: item.text });
        break;
      }
      case "tool_call": {
        // A call can appear once per lifecycle update; its latest state takes its first place.
        const index = toolIndex.get(item.callId);
        if (index === undefined) {
          toolIndex.set(item.callId, raws.length);
          raws.push({ kind: "tool", item });
        } else {
          raws[index] = { kind: "tool", item };
        }
        break;
      }
      case "todo":
        // Each item is a snapshot of the whole list; only the latest one is still true.
        if (tasksIndex !== null) raws[tasksIndex] = null;
        tasksIndex = raws.length;
        raws.push({ kind: "tasks", items: item.items });
        break;
      case "error":
        raws.push({ kind: "note", text: `[Error] ${item.message}` });
        break;
      case "notification":
        if (item.level !== "info") raws.push({ kind: "note", text: `[Notice] ${item.message}` });
        break;
      case "compaction":
        if (item.status === "completed") {
          raws.push({ kind: "note", text: "[The agent compacted its context here]" });
        }
        break;
      default:
        // Plugin rows were never part of the conversation.
        break;
    }
  }
  return raws.filter((raw): raw is Raw => raw !== null);
}

function toEntry(raw: Raw): Entry | null {
  switch (raw.kind) {
    case "user":
    case "assistant": {
      const text = raw.text.trim();
      if (!text) return null;
      const label = raw.kind === "user" ? "User" : "Assistant";
      return {
        text: `[${label}]\n${clip(text, MAX_MESSAGE_CHARS)}`,
        extra: null,
        role: raw.kind === "user" ? "user" : "other",
      };
    }
    case "thinking": {
      const text = raw.text.trim();
      if (!text) return null;
      return { text: "", extra: `[Thinking]\n${clip(text, MAX_THINKING_CHARS)}`, role: "other" };
    }
    case "note":
      return { text: clip(raw.text.trim(), MAX_ERROR_CHARS), extra: null, role: "other" };
    case "tasks": {
      if (raw.items.length === 0) return null;
      const lines = raw.items.map((task) => `- [${task.completed ? "x" : " "}] ${oneLine(task.text)}`);
      return { text: `[Tasks]\n${lines.join("\n")}`, extra: null, role: "other" };
    }
    case "tool":
      return toolEntry(raw.item);
  }
}

function toolEntry(item: ToolCall): Entry {
  const { summary, output, suffix } = describe(item.detail);
  const head = `[Tool: ${item.name}]${summary ? ` ${clip(oneLine(summary), MAX_SUMMARY_CHARS)}` : ""}`;
  switch (item.status) {
    case "running":
      return { text: `${head}\n${IN_PROGRESS_OUTPUT}`, extra: null, role: "other" };
    case "failed":
      return {
        text: `${head} (failed: ${clip(oneLine(errorText(item.error)), MAX_ERROR_CHARS)})`,
        extra: outputBlock(item.detail.type, output),
        role: "other",
      };
    case "canceled":
      return { text: `${head} (canceled)`, extra: null, role: "other" };
    case "completed":
      return {
        text: suffix ? `${head} ${suffix}` : head,
        extra: outputBlock(item.detail.type, output),
        role: "other",
      };
  }
}

function outputBlock(type: ToolDetail["type"], output: string | null): string | null {
  const text = output?.trim();
  return text ? `<output>\n${clip(text, OUTPUT_CHARS[type])}\n</output>` : null;
}

interface Description {
  summary: string;
  output: string | null;
  suffix?: string;
}

function describe(detail: ToolDetail): Description {
  switch (detail.type) {
    case "shell":
      return {
        summary: detail.command,
        output: detail.output ?? null,
        suffix:
          typeof detail.exitCode === "number" && detail.exitCode !== 0
            ? `(exit code ${detail.exitCode})`
            : undefined,
      };
    case "read":
      return { summary: detail.filePath, output: detail.content ?? null };
    case "edit":
      return {
        summary: detail.filePath,
        output: detail.unifiedDiff ?? replacement(detail.oldString, detail.newString),
      };
    case "write":
      return { summary: detail.filePath, output: detail.content ?? null };
    case "search":
      return {
        summary: detail.query,
        output:
          detail.content ??
          detail.filePaths?.join("\n") ??
          detail.webResults?.map((result) => `${result.title} ${result.url}`).join("\n") ??
          null,
      };
    case "fetch":
      return { summary: detail.url, output: detail.result ?? null };
    case "sub_agent":
      return {
        summary: [detail.subAgentType, detail.description].filter(Boolean).join(": "),
        output: detail.log,
      };
    case "plain_text":
      return { summary: detail.label ?? "", output: detail.text ?? null };
    case "plan":
      return { summary: "", output: detail.text };
    case "worktree_setup":
      return { summary: `${detail.branchName} at ${detail.worktreePath}`, output: detail.log };
    case "unknown":
      return { summary: json(detail.input), output: detail.output == null ? null : json(detail.output) };
  }
}

function replacement(oldString: string | undefined, newString: string | undefined): string | null {
  if (oldString === undefined && newString === undefined) return null;
  const prefix = (text: string | undefined, mark: string) =>
    text === undefined ? [] : text.split("\n").map((line) => `${mark} ${line}`);
  return [...prefix(oldString, "-"), ...prefix(newString, "+")].join("\n");
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string") return message;
  return error == null ? "unknown error" : json(error);
}

function json(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Keeps the start and, a little more, the end, where logs report how things went. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - markerFor(text.length).length);
  const head = Math.floor(keep * 0.4);
  return `${text.slice(0, head)}${markerFor(text.length - keep)}${text.slice(text.length - (keep - head))}`;
}

function markerFor(omitted: number): string {
  return `\n[… ${omitted} characters left out …]\n`;
}
