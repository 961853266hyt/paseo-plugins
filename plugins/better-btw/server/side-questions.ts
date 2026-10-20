import { modelFor, type SideQuestionSettings } from "../shared/settings";
import {
  type Exchange,
  type ExchangeSummary,
  MAX_QUESTION_CHARS,
  MAX_REPLAYED_EXCHANGES,
  type Thread,
  USAGE,
} from "../shared/thread";
import type { AnswerOutcome } from "./claude";
import type { AgentContext } from "./context";
import { buildPrompt, type ReplayedExchange } from "./prompt";

/** Side questions answering at once across all agents; each one is a `claude` process. */
export const MAX_CONCURRENT_ANSWERS = 3;
/** Side questions one agent can have answering at once; more are refused, not queued. */
export const MAX_ANSWERING_PER_AGENT = 5;
/** How long a side question waits for a free slot before it gives up. */
export const SLOT_WAIT_MS = 60_000;

export interface AnswerJob {
  prompt: string;
  /** For `claude --model`; null leaves Claude Code on its default. */
  model: string | null;
  signal: AbortSignal;
  onText(text: string): void;
}

/** Reads the agent's conversation through the plugin process's daemon session. */
export type ContextLoader = (signal: AbortSignal) => Promise<AgentContext>;

export interface SideQuestionDeps {
  settings(): SideQuestionSettings;
  answer(job: AnswerJob): Promise<AnswerOutcome>;
  createId(): string;
  now(): number;
  log(message: string): void;
  logError(message: string, error: unknown): void;
}

export interface SideQuestionService {
  /** Starts answering and returns the new exchange's ID. Throws on an empty or oversized question. */
  ask(agentId: string, question: string, load: ContextLoader): string;
  thread(agentId: string, focusId: string | null): Thread;
  stop(agentId: string, exchangeId: string): void;
  /** Forgets the earlier side questions, keeping the current one and any still answering. */
  clear(agentId: string): void;
  /** The agent closed or was archived. */
  forget(agentId: string): void;
  dispose(): void;
}

interface Entry extends Exchange {
  /** Answered with a real answer, so later side questions replay it. */
  replayable: boolean;
  controller: AbortController | null;
}

type Release = () => void;

/** Hands out a fixed number of slots; waiters get them in order and give up on abort or timeout. */
function createSlots(limit: number) {
  let free = limit;
  const waiters: Array<(granted: boolean) => void> = [];

  function grant(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiters.shift();
      if (next) next(true);
      else free += 1;
    };
  }

  return {
    acquire(signal: AbortSignal, waitMs: number): Promise<Release | null> {
      if (signal.aborted) return Promise.resolve(null);
      if (free > 0) {
        free -= 1;
        return Promise.resolve(grant());
      }
      return new Promise((resolve) => {
        function settle(granted: boolean): void {
          clearTimeout(timer);
          signal.removeEventListener("abort", giveUp);
          const index = waiters.indexOf(settle);
          if (index !== -1) waiters.splice(index, 1);
          resolve(granted ? grant() : null);
        }
        function giveUp(): void {
          settle(false);
        }
        const timer = setTimeout(giveUp, waitMs);
        signal.addEventListener("abort", giveUp, { once: true });
        waiters.push(settle);
      });
    },
  };
}

export function createSideQuestionService(deps: SideQuestionDeps): SideQuestionService {
  /** Per agent, oldest first. Kept in daemon memory only, like Claude Code keeps its in the session. */
  const threads = new Map<string, Entry[]>();
  const slots = createSlots(MAX_CONCURRENT_ANSWERS);

  function finish(entry: Entry, outcome: AnswerOutcome): void {
    // Stopped or forgotten while it ran: the outcome no longer applies.
    if (entry.status !== "answering") return;
    switch (outcome.kind) {
      case "answered":
        entry.status = "answered";
        entry.answer = outcome.text;
        entry.model = outcome.model ?? entry.model;
        entry.replayable = outcome.replayable;
        break;
      case "failed":
        entry.status = "failed";
        entry.error = outcome.error;
        entry.model = outcome.model ?? entry.model;
        break;
      case "stopped":
        entry.status = "stopped";
        if (outcome.text) entry.answer = outcome.text;
        break;
    }
  }

  /** Keeps the newest answered side questions that later ones replay; older ones are dropped. */
  function trim(entries: Entry[]): void {
    let replayable = entries.filter((entry) => entry.replayable).length;
    for (let index = 0; index < entries.length && replayable > MAX_REPLAYED_EXCHANGES; ) {
      if (entries[index]!.replayable) {
        entries.splice(index, 1);
        replayable -= 1;
      } else {
        index += 1;
      }
    }
  }

  function forget(agentId: string): void {
    const entries = threads.get(agentId);
    if (!entries) return;
    threads.delete(agentId);
    for (const entry of entries) {
      if (entry.status === "answering") entry.status = "stopped";
      entry.controller?.abort();
    }
  }

  async function run(
    agentId: string,
    entry: Entry,
    earlier: readonly ReplayedExchange[],
    load: ContextLoader,
    controller: AbortController,
  ): Promise<void> {
    const { signal } = controller;
    const startedAt = deps.now();
    let release: Release | null = null;
    try {
      release = await slots.acquire(signal, SLOT_WAIT_MS);
      if (signal.aborted) return;
      if (!release) {
        finish(entry, {
          kind: "failed",
          error: "Too many side questions are answering right now. Try again in a moment.",
          model: null,
        });
        deps.log(`No slot in time for a side question about agent ${agentId}`);
        return;
      }
      const context = await load(signal);
      if (signal.aborted) return;
      const model = modelFor(deps.settings(), context);
      entry.model = model;
      const outcome = await deps.answer({
        prompt: buildPrompt({
          transcript: context.transcript,
          agentRunning: context.running,
          earlier,
          question: entry.question,
        }),
        model,
        signal,
        onText: (text) => {
          if (entry.status === "answering") entry.answer = text;
        },
      });
      finish(entry, outcome);
      const seconds = ((deps.now() - startedAt) / 1000).toFixed(1);
      deps.log(
        `Side question about agent ${agentId} ${entry.status} in ${seconds}s` +
          ` (model ${entry.model ?? "default"}, ${context.transcript.length} transcript characters)`,
      );
    } catch (error) {
      if (signal.aborted) return;
      deps.logError(`Side question about agent ${agentId} failed`, error);
      finish(entry, { kind: "failed", error: `Could not answer: ${messageOf(error)}`, model: null });
    } finally {
      release?.();
      if (entry.controller === controller) entry.controller = null;
      const entries = threads.get(agentId);
      if (entries) trim(entries);
    }
  }

  return {
    ask(agentId, question, load) {
      const text = question.trim();
      if (!text) throw new Error(USAGE);
      if (text.length > MAX_QUESTION_CHARS) {
        throw new Error(
          `A side question can be at most ${MAX_QUESTION_CHARS.toLocaleString("en-US")} characters.`,
        );
      }
      const entries = threads.get(agentId) ?? [];
      const answering = entries.filter((entry) => entry.status === "answering").length;
      if (answering >= MAX_ANSWERING_PER_AGENT) {
        throw new Error("Wait for an earlier side question to finish, or stop one, before asking another.");
      }
      // Like Claude Code's thread, only real answers outlive the next question.
      const kept = entries.filter((entry) => entry.status === "answering" || entry.replayable);
      const earlier = kept
        .filter((entry) => entry.replayable)
        .map((entry) => ({ question: entry.question, answer: entry.answer }));
      const controller = new AbortController();
      const entry: Entry = {
        id: deps.createId(),
        question: text,
        status: "answering",
        answer: "",
        error: null,
        model: null,
        askedAt: deps.now(),
        replayable: false,
        controller,
      };
      kept.push(entry);
      threads.set(agentId, kept);
      void run(agentId, entry, earlier, load, controller);
      return entry.id;
    },

    thread(agentId, focusId) {
      const entries = threads.get(agentId) ?? [];
      const focus = entries.find((entry) => entry.id === focusId) ?? entries.at(-1) ?? null;
      return { exchanges: entries.map(summarize), focus: focus ? publish(focus) : null };
    },

    stop(agentId, exchangeId) {
      const entry = threads.get(agentId)?.find((candidate) => candidate.id === exchangeId);
      if (!entry || entry.status !== "answering") return;
      entry.status = "stopped";
      entry.controller?.abort();
    },

    clear(agentId) {
      const entries = threads.get(agentId);
      if (!entries) return;
      const current = entries.at(-1);
      threads.set(
        agentId,
        entries.filter((entry) => entry === current || entry.status === "answering"),
      );
    },

    forget,

    dispose() {
      for (const agentId of Array.from(threads.keys())) forget(agentId);
    },
  };
}

function summarize(entry: Entry): ExchangeSummary {
  return { id: entry.id, question: entry.question, status: entry.status };
}

function publish(entry: Entry): Exchange {
  return {
    id: entry.id,
    question: entry.question,
    status: entry.status,
    answer: entry.answer,
    error: entry.error,
    model: entry.model,
    askedAt: entry.askedAt,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
