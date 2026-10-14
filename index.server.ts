import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { generateSuggestion } from "./server/generate";
import { createSuggestionCoordinator, type RowWriter } from "./server/suggestions";
import { SUGGESTION_ROW_KIND, SUGGESTION_ROW_VERSION } from "./shared/suggestion-row";

const MODEL = "haiku";

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
  const coordinator = createSuggestionCoordinator({
    generate: (transcript, signal) => generateSuggestion({ transcript, model: MODEL, signal }),
    // Row ids must stay unique across plugin reloads: daemon memory keeps earlier rows.
    createRowId: () => `suggestion-${randomUUID()}`,
    log: (message) => console.log(`[prompt-suggestions] ${message}`),
    logError: (message, error) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[prompt-suggestions] ${message}: ${detail}`);
    },
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
    coordinator.dispose();
  };
}
