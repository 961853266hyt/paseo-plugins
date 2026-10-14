import type { PluginClientContext } from "@getpaseo/plugin/client";
import { watchAgentActivity } from "./client/agent-activity";
import { SuggestionSettingsScreen } from "./client/settings-screen";
import { createSuggestionRow } from "./client/suggestion-row";
import { createSuggestionStore } from "./client/suggestion-store";
import { startComposerBridge } from "./client/web";
import {
  SUGGESTION_ROW_KIND,
  SUGGESTION_ROW_VERSION,
  suggestionRowSchema,
} from "./shared/suggestion-row";

export default function contribute(client: PluginClientContext) {
  const store = createSuggestionStore();
  client.addTimelineRenderer({
    kind: SUGGESTION_ROW_KIND,
    version: SUGGESTION_ROW_VERSION,
    schema: suggestionRowSchema,
    Component: createSuggestionRow(store),
  });
  client.addSettingsScreen({
    id: "suggestions",
    title: "Prompt suggestions",
    icon: "Sparkles",
    Component: SuggestionSettingsScreen,
  });
  const stopBridge = startComposerBridge(store);
  const stopWatching = watchAgentActivity(client, store);
  return () => {
    stopBridge();
    stopWatching();
  };
}
