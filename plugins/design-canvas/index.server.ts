import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ENABLED_LABEL } from "./shared/prompts";
import { registerHandlers } from "./server/handlers";
import { isInitialized } from "./server/store";
import { createDesignTools } from "./server/tools";

export default function contribute(server: PluginServerContext) {
  registerHandlers(server);

  const tools = createDesignTools();
  // Tools attach when a session opens: agents in a workspace that uses the canvas, or labelled for it.
  // The canvas reloads an existing agent's session after it first sets a workspace up.
  const stopHook = server.addHook("agent.open.before", async ({ request }) => {
    if (request.purpose !== "interactive") return;
    if (request.labels[ENABLED_LABEL] !== "true" && !(await isInitialized(request.cwd))) return;
    return { ...request, tools: [...request.tools, ...tools] };
  });

  return () => {
    stopHook();
  };
}
