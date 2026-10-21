import type { PluginServerContext, PluginSettingsState } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { setFlagsFromString } from "node:v8";
import { answerWithClaude } from "./server/claude";
import { loadAgentContext } from "./server/context";
import { createSideQuestionService } from "./server/side-questions";
import {
  DEFAULT_SETTINGS,
  type SideQuestionSettings,
  sideQuestionSettings,
} from "./shared/settings";
import {
  askSideQuestion,
  clearSideQuestions,
  getThread,
  stopSideQuestion,
} from "./shared/thread";

// The daemon client in this process checks every message with a generated validator of about
// 11 MB. Where V8's Maglev is on, as on Node 24, it recompiles that function again and again and
// the process grows past 1 GB; Prompt suggestions measured 2.2 GB against 277 MB without it.
setFlagsFromString("--no-maglev");

function log(message: string): void {
  console.log(`[better-btw] ${message}`);
}

function logError(message: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[better-btw] ${message}: ${detail}`);
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(sideQuestionSettings);
  // Asked for explicitly, so a side question still runs, on the defaults, while settings are invalid.
  let current: SideQuestionSettings = DEFAULT_SETTINGS;
  let changed = false;
  function apply(state: PluginSettingsState<typeof sideQuestionSettings.schema>): void {
    if (state.status === "ready") {
      current = state.values;
    } else {
      current = DEFAULT_SETTINGS;
      logError("Settings are invalid, so side questions use the defaults", state.error);
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

  const service = createSideQuestionService({
    settings: () => current,
    answer: (job) => answerWithClaude(job),
    createId: () => randomUUID(),
    now: () => Date.now(),
    log,
    logError,
  });

  server.handle(askSideQuestion, ({ agentId, question }, { paseo }) => ({
    exchangeId: service.ask(agentId, question, (signal) =>
      loadAgentContext(paseo, agentId, signal),
    ),
  }));
  server.handle(getThread, ({ agentId, focusId }) => service.thread(agentId, focusId));
  server.handle(stopSideQuestion, ({ agentId, exchangeId }) => {
    service.stop(agentId, exchangeId);
    return {};
  });
  server.handle(clearSideQuestions, ({ agentId }) => {
    service.clear(agentId);
    return {};
  });

  // Closing only releases an agent's runtime (reloads do it too); archiving is when it goes away.
  const stopArchived = server.on("agent.archived", (event) => service.forget(event.agent.id));

  return () => {
    stopArchived();
    stopSettings();
    service.dispose();
  };
}
