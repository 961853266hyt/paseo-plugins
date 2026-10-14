import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { SuggestionStore } from "./suggestion-store";

/**
 * The daemon dismisses a suggestion's row when the next turn opens, but a row this client has not
 * rendered (scrolled away, say) cannot pass that on. Agent status closes the gap: a suggestion
 * only stands while its agent is idle.
 */
export function watchAgentActivity(client: PluginClientContext, store: SuggestionStore): () => void {
  const lifetime = new AbortController();
  let stopped = false;

  function observe(agent: { id: string; status: string }): void {
    if (agent.status !== "idle") store.remove(agent.id);
  }

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const { agent } of entries) observe(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") store.remove(update.agentId);
          else observe(update.agent);
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("[prompt-suggestions] Agent observation failed", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
  };
}
