import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { type SuggestionSettings, suggestsFor } from "../shared/settings";
import type { SuggestionRow } from "../shared/suggestion-row";
import { normalizeSuggestion } from "./filter";
import { GENERATION_TIMEOUT_MS } from "./generate";
import { buildTranscript, countUserMessages } from "./transcript";

type TurnEndedEvent = PluginLifecycleEvents["agent.turn_ended"];

/** Generations running at once across all agents; each one is a `claude` process. */
export const MAX_CONCURRENT_GENERATIONS = 2;
/** A run takes about three seconds; one started with less budget left would only be killed. */
const MIN_RUN_MS = 5_000;

/** Writes this plugin's row for one agent; the same row id replaces the earlier row in place. */
export type RowWriter = (rowId: string, row: SuggestionRow) => Promise<void>;

export interface GenerationRequest {
  transcript: string;
  model: string;
  /** What is left of the budget after waiting for a slot. */
  timeoutMs: number;
  signal: AbortSignal;
}

export interface SuggestionCoordinatorDeps {
  /** Current settings, or null while they load or when they are invalid: then nothing is suggested. */
  settings(): SuggestionSettings | null;
  generate(request: GenerationRequest): Promise<string | null>;
  createRowId(): string;
  log(message: string): void;
  logError(message: string, error: unknown): void;
}

interface AgentState {
  /** Generation in flight for the turn that just ended. */
  controller: AbortController | null;
  /** Row currently shown as `ready`, which the next turn must dismiss. */
  liveRowId: string | null;
}

export interface SuggestionCoordinator {
  turnEnded(event: TurnEndedEvent, write: RowWriter, hookSignal: AbortSignal): Promise<void>;
  /** The suggestion no longer applies: a turn opened, or the agent closed or was archived. */
  invalidate(agentId: string, write: RowWriter): Promise<void>;
  dispose(): void;
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
      // A freed slot goes straight to the next waiter.
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

export function createSuggestionCoordinator(deps: SuggestionCoordinatorDeps): SuggestionCoordinator {
  const agents = new Map<string, AgentState>();
  const slots = createSlots(MAX_CONCURRENT_GENERATIONS);

  function stateOf(agentId: string): AgentState {
    let state = agents.get(agentId);
    if (!state) {
      state = { controller: null, liveRowId: null };
      agents.set(agentId, state);
    }
    return state;
  }

  async function writeSafely(write: RowWriter, rowId: string, row: SuggestionRow): Promise<void> {
    try {
      await write(rowId, row);
    } catch (error) {
      deps.logError(`Could not write suggestion row ${rowId}`, error);
    }
  }

  async function dismissLive(state: AgentState, write: RowWriter): Promise<void> {
    state.controller?.abort();
    state.controller = null;
    const rowId = state.liveRowId;
    state.liveRowId = null;
    if (rowId) await writeSafely(write, rowId, { status: "dismissed" });
  }

  return {
    async turnEnded(event, write, hookSignal) {
      const state = stateOf(event.agent.id);
      await dismissLive(state, write);

      const isTopLevel = event.agent.parentAgentId === null;
      const isCompleted = event.outcome.kind === "completed";
      // Like Claude Code, the first exchange gets no suggestion.
      const hasHistory = countUserMessages(event.timeline) >= 2;
      if (!isTopLevel || !isCompleted || !hasHistory) return;
      const settings = deps.settings();
      if (!settings || !suggestsFor(settings, event.agent.provider)) return;

      const transcript = buildTranscript(event.timeline);
      if (transcript.length === 0) return;

      const controller = new AbortController();
      const abortWithHook = () => controller.abort();
      hookSignal.addEventListener("abort", abortWithHook, { once: true });
      state.controller = controller;
      const startedAt = Date.now();
      let raw: string | null;
      try {
        // Waiting spends the same budget as the run, so the hook still ends in time.
        const release = await slots.acquire(controller.signal, GENERATION_TIMEOUT_MS - MIN_RUN_MS);
        if (!release || controller.signal.aborted) {
          release?.();
          if (state.controller === controller) state.controller = null;
          if (!controller.signal.aborted) {
            deps.log(`No suggestion for agent ${event.agent.id}: no free slot in time`);
          }
          return;
        }
        try {
          raw = await deps.generate({
            transcript,
            model: settings.model,
            timeoutMs: GENERATION_TIMEOUT_MS - (Date.now() - startedAt),
            signal: controller.signal,
          });
        } finally {
          release();
        }
      } catch (error) {
        if (state.controller === controller) state.controller = null;
        deps.logError(`Suggestion generation failed for agent ${event.agent.id}`, error);
        return;
      } finally {
        hookSignal.removeEventListener("abort", abortWithHook);
      }
      if (controller.signal.aborted || state.controller !== controller) return;
      state.controller = null;

      const text = normalizeSuggestion(raw);
      if (!text) {
        deps.log(`No suggestion for agent ${event.agent.id}: model replied ${JSON.stringify(raw)}`);
        return;
      }
      deps.log(`Suggested ${JSON.stringify(text)} for agent ${event.agent.id}`);
      const rowId = deps.createRowId();
      // Claimed before the write, so a turn opening during it still dismisses this row.
      state.liveRowId = rowId;
      await writeSafely(write, rowId, { status: "ready", text });
    },

    async invalidate(agentId, write) {
      const state = agents.get(agentId);
      if (!state) return;
      await dismissLive(state, write);
    },

    dispose() {
      for (const state of agents.values()) state.controller?.abort();
      agents.clear();
    },
  };
}
