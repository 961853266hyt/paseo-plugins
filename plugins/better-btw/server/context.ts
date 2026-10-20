import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { buildTranscript, type TimelineItem } from "./transcript";

type Paseo = PluginHandlerContext["paseo"];
type TimelineHandle = ReturnType<Paseo["agents"]["ref"]>["timeline"];
type TimelinePage = Awaited<ReturnType<TimelineHandle["refetch"]>>;
type TimelineEntry = TimelinePage["entries"][number];

const PAGE_ENTRIES = 200;
/**
 * Message text worth fetching: the transcript keeps at most 100,000 characters, messages first,
 * so history beyond this would be cut anyway. Tool output is not counted; it is clipped per call.
 */
const MAX_FETCHED_MESSAGE_CHARS = 200_000;
const MAX_PAGES = 30;
const OPENING_ENTRIES = 20;

export interface AgentContext {
  provider: string;
  /** The agent's model ID, or null when it runs on its provider's default. */
  model: string | null;
  /** Mid-turn: the transcript's last entries may be incomplete. */
  running: boolean;
  transcript: string;
}

/**
 * Reads the agent's conversation newest first, page by page, until there is enough to fill the
 * transcript. A long session's full timeline can run to many megabytes of file contents and logs.
 */
export async function loadAgentContext(
  paseo: Paseo,
  agentId: string,
  signal: AbortSignal,
): Promise<AgentContext> {
  const timeline = paseo.agents.ref(agentId).timeline;
  const newest = await timeline.refetch({ direction: "tail", limit: PAGE_ENTRIES });
  const agent = newest.agent;
  if (!agent) throw new Error("The agent was not found.");

  const pages: TimelineEntry[][] = [newest.entries];
  let oldest = newest;
  let messageChars = countMessageChars(newest.entries);
  while (
    oldest.hasOlder &&
    oldest.startCursor &&
    messageChars < MAX_FETCHED_MESSAGE_CHARS &&
    pages.length < MAX_PAGES &&
    !signal.aborted
  ) {
    const page = await timeline.refetch({
      direction: "before",
      cursor: oldest.startCursor,
      limit: PAGE_ENTRIES,
    });
    // The timeline was rebuilt meanwhile, say after a reload; what was read so far still stands.
    if (page.reset || page.staleCursor || page.epoch !== newest.epoch) break;
    pages.unshift(page.entries);
    messageChars += countMessageChars(page.entries);
    oldest = page;
  }

  const items: TimelineItem[] = pages.flat().map((entry) => entry.item);
  const olderHistory = oldest.hasOlder
    ? { firstUserMessage: await readFirstUserMessage(timeline, oldest) }
    : undefined;
  return {
    provider: agent.provider,
    model: agent.model,
    running: agent.status === "running",
    transcript: buildTranscript(items, { olderHistory }),
  };
}

/** The session's opening request, which usually states the task, when it was not fetched. */
async function readFirstUserMessage(
  timeline: TimelineHandle,
  oldest: TimelinePage,
): Promise<string | null> {
  const firstFetched = oldest.entries[0]?.seqStart ?? Number.POSITIVE_INFINITY;
  try {
    const page = await timeline.refetch({
      direction: "after",
      cursor: { epoch: oldest.epoch, seq: 0 },
      limit: OPENING_ENTRIES,
    });
    if (page.reset || page.staleCursor || page.epoch !== oldest.epoch) return null;
    const opening = page.entries.find(
      (entry) => entry.item.type === "user_message" && entry.seqStart < firstFetched,
    );
    return opening?.item.type === "user_message" ? opening.item.text : null;
  } catch {
    return null;
  }
}

function countMessageChars(entries: readonly TimelineEntry[]): number {
  let chars = 0;
  for (const { item } of entries) {
    if (item.type === "user_message" || item.type === "assistant_message") chars += item.text.length;
  }
  return chars;
}
