import type { PluginCommandCapabilities } from "@getpaseo/plugin/client";
import { newDesignPrompt } from "../shared/prompts";

type Paseo = PluginCommandCapabilities["paseo"];

/**
 * Sets the workspace up for the canvas and asks the agent for a design. The design tools attach
 * when a session opens, so an agent that started before the workspace used the canvas is reloaded
 * first to get them.
 */
export async function startDesign(input: {
  paseo: Paseo;
  initCanvas: () => Promise<{ created: boolean }>;
  agentId: string;
  brief: string;
}): Promise<void> {
  const { created } = await input.initCanvas();
  const agent = input.paseo.agents.ref(input.agentId);
  if (created) await agent.reload();
  await agent.send(newDesignPrompt(input.brief));
}
