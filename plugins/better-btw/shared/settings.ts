import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Stored instead of a model name: answer with the agent's own model, as Claude Code does. */
export const SAME_AS_AGENT = "agent";
/** Answers for agents whose model Claude Code cannot run, such as Codex or OpenCode agents. */
export const FALLBACK_MODEL = "sonnet";

/** Passed to `claude --model`; a leading dash would read as a flag. */
const CLI_MODEL = /^[^\s-]\S*$/;

/** Host-wide settings, edited under Settings → Plugins and read live by the daemon. */
export const sideQuestionSettings = defineSettings({
  id: "side-questions",
  scope: "host",
  version: 1,
  schema: z.object({
    model: z.string().trim().regex(CLI_MODEL, "Enter a model such as sonnet").default(SAME_AS_AGENT),
  }),
});

export type SideQuestionSettings = z.output<typeof sideQuestionSettings.schema>;

export const DEFAULT_SETTINGS: SideQuestionSettings = { model: SAME_AS_AGENT };

export interface AgentModel {
  provider: string;
  /** The agent's model ID, or null when it runs on its provider's default. */
  model: string | null;
}

/**
 * The model for `claude --model`, or null to leave Claude Code on its own default. A Claude agent
 * on its provider default gets null, which is the same default when both read the same login.
 */
export function modelFor(settings: SideQuestionSettings, agent: AgentModel): string | null {
  if (settings.model !== SAME_AS_AGENT) return settings.model;
  if (agent.provider !== "claude") return FALLBACK_MODEL;
  if (agent.model === null) return null;
  return CLI_MODEL.test(agent.model) ? agent.model : FALLBACK_MODEL;
}
