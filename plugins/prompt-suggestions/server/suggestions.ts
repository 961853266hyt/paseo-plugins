import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { type SuggestionSettings, suggestsFor } from "../shared/settings";
import type { SuggestionRow } from "../shared/suggestion-row";
import { normalizeSuggestion } from "./filter";
import { buildTranscript, countUserMessages } from "./transcript";

type TurnEndedEvent = PluginLifecycleEvents["agent.turn_ended"];

/** Writes this plugin's row for one agent; the same row id replaces the earlier row in place. */
export type RowWriter = (rowId: string, row: SuggestionRow) => Promise<void>;

export interface GenerationRequest {
  transcript: string;
  model: string;
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

export function createSuggestionCoordinator(deps: SuggestionCoordinatorDeps): SuggestionCoordinator {
  const agents = new Map<string, AgentState>();

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
      let raw: string | null;
      try {
        raw = await deps.generate({ transcript, model: settings.model, signal: controller.signal });
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
