import type {
  PluginHookContext,
  PluginServerContext,
  PluginSettingsState,
} from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { setFlagsFromString } from "node:v8";
import { generateSuggestion } from "./server/generate";
import { createSuggestionCoordinator, type RowWriter } from "./server/suggestions";
import { type SuggestionSettings, suggestionSettings } from "./shared/settings";
import { SUGGESTION_ROW_KIND, SUGGESTION_ROW_VERSION } from "./shared/suggestion-row";

// This process checks every daemon message with one generated validator of about 11 MB
// (`safeParse_WSOutboundMessageSchema` in @getpaseo/protocol). Where Maglev is on, as on Node 24,
// Maglev compiles it again and again on a worker thread, and glibc keeps the native memory: a
// 3-minute load reached 2.2 GB, against 277 MB without Maglev. Turbofan already skips a function
// this large. The bundle runs before the daemon client connects, so this precedes the first
// message.
setFlagsFromString("--no-maglev");

function log(message: string): void {
  console.log(`[prompt-suggestions] ${message}`);
}

function logError(message: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[prompt-suggestions] ${message}: ${detail}`);
}

function rowWriter(agentId: string, { paseo }: PluginHookContext): RowWriter {
  return async (rowId, row) => {
    await paseo.agents.ref(agentId).timeline.append({
      type: "plugin",
      id: rowId,
      kind: SUGGESTION_ROW_KIND,
      version: SUGGESTION_ROW_VERSION,
      data: row,
    });
  };
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(suggestionSettings);
  // Null until the first read and while the stored settings are invalid.
  let current: SuggestionSettings | null = null;
  let changed = false;
  function apply(state: PluginSettingsState<typeof suggestionSettings.schema>): void {
    if (state.status === "ready") {
      current = state.values;
    } else {
      current = null;
      logError("Settings are invalid, so no suggestions are made", state.error);
    }
  }
  // Saves apply live, without a plugin reload; a save that lands first wins over the initial read.
  const stopSettings = settings.subscribe((state) => {
    changed = true;
    apply(state);
  });
  void settings.read().then(
    (state) => {
      if (!changed) apply(state);
    },
    (error) => logError("Could not read settings", error),
  );

  const coordinator = createSuggestionCoordinator({
    settings: () => current,
    generate: (request) => generateSuggestion(request),
    // Row ids must stay unique across plugin reloads: daemon memory keeps earlier rows.
    createRowId: () => `suggestion-${randomUUID()}`,
    log,
    logError,
  });

  const removers = [
    server.on("agent.turn_ended", (event, context) =>
      coordinator.turnEnded(event, rowWriter(event.agent.id, context), context.signal),
    ),
    server.on("agent.turn_started", (event, context) =>
      coordinator.invalidate(event.agent.id, rowWriter(event.agent.id, context)),
    ),
    server.on("agent.closed", (event, context) =>
      coordinator.invalidate(event.agent.id, rowWriter(event.agent.id, context)),
    ),
    server.on("agent.archived", (event, context) =>
      coordinator.invalidate(event.agent.id, rowWriter(event.agent.id, context)),
    ),
  ];

  return () => {
    for (const remove of removers) remove();
    stopSettings();
    coordinator.dispose();
  };
}
