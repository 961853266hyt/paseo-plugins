import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";

export type TimelineItem = PluginLifecycleEvents["agent.turn_ended"]["timeline"][number];

const DEFAULT_BUDGET_CHARS = 6000;
const MAX_ENTRY_CHARS = 1500;
const HEAD_CHARS = 300;

interface Entry {
  role: "User" | "Assistant" | "Tool" | "Error";
  text: string;
}

export function countUserMessages(timeline: readonly TimelineItem[]): number {
  return timeline.filter((item) => item.type === "user_message").length;
}

/**
 * The recent conversation as plain lines, newest last, within `budgetChars`.
 * Assistant text can span several items, so consecutive chunks are joined before clipping.
 */
export function buildTranscript(
  timeline: readonly TimelineItem[],
  budgetChars = DEFAULT_BUDGET_CHARS,
): string {
  const lines = toEntries(timeline).map(
    (entry) => `${entry.role}: ${clip(entry.text.trim(), MAX_ENTRY_CHARS)}`,
  );
  const kept: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (used + line.length > budgetChars && kept.length > 0) break;
    kept.unshift(line);
    used += line.length + 1;
  }
  return kept.join("\n");
}

function toEntries(timeline: readonly TimelineItem[]): Entry[] {
  const entries: Entry[] = [];
  for (const item of timeline) {
    const entry = toEntry(item);
    if (!entry) continue;
    const previous = entries.at(-1);
    if (entry.role === "Assistant" && previous?.role === "Assistant") {
      previous.text += entry.text;
      continue;
    }
    entries.push(entry);
  }
  return entries.filter((entry) => entry.text.trim().length > 0);
}

function toEntry(item: TimelineItem): Entry | null {
  switch (item.type) {
    case "user_message":
      return { role: "User", text: item.text };
    case "assistant_message":
      return { role: "Assistant", text: item.text };
    case "tool_call":
      return { role: "Tool", text: `${item.name} (${item.status})` };
    case "error":
      return { role: "Error", text: item.message };
    default:
      return null;
  }
}

/** Keeps the opening and, above all, the end of a long message, where follow-ups are offered. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = max - HEAD_CHARS - 3;
  return `${text.slice(0, HEAD_CHARS)} … ${text.slice(text.length - tail)}`;
}
