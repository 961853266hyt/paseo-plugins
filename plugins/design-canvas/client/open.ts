import type { PluginClientContext, PluginCommandCapabilities } from "@getpaseo/plugin/client";
import type { DesignKind } from "../shared/design";
import { ENABLED_LABEL, newDesignPrompt } from "../shared/prompts";

type Paseo = PluginCommandCapabilities["paseo"];
type Navigation = { openAgent(input: { agentId: string }): void } | undefined;

export const PANEL_ID = "design";

/** What a Design panel should show when it opens, or right away if it is already open. */
export type Handoff = { kind: "design"; slug: string } | { kind: "new"; known: string[] };

const pending = new Map<string, Handoff>();
const listeners = new Map<string, Set<(handoff: Handoff) => void>>();

/** Passes a design to the agent's Design panel: to the open one, else to the next one that mounts. */
export function handOff(agentId: string, handoff: Handoff): void {
  const open = listeners.get(agentId);
  if (open?.size) {
    for (const listener of open) listener(handoff);
    return;
  }
  pending.set(agentId, handoff);
}

export function takeHandoff(agentId: string): Handoff | undefined {
  const handoff = pending.get(agentId);
  pending.delete(agentId);
  return handoff;
}

export function listenHandoff(agentId: string, listener: (handoff: Handoff) => void): () => void {
  const set = listeners.get(agentId) ?? new Set();
  set.add(listener);
  listeners.set(agentId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(agentId);
  };
}

/** New agents get the setup of the agent the user started last. */
async function defaultConfig(paseo: Paseo): Promise<{ provider: string; modeId?: string }> {
  const { entries } = await paseo.agents.list({
    sort: [{ key: "created_at", direction: "desc" }],
    page: { limit: 20 },
  });
  const agent = entries.map((entry) => entry.agent).find((candidate) => !candidate.internal);
  if (!agent) return { provider: "claude" };
  return {
    provider: agent.model ? `${agent.provider}/${agent.model}` : agent.provider,
    ...(agent.currentModeId ? { modeId: agent.currentModeId } : {}),
  };
}

interface Place {
  agentId: string;
  workspaceId: string;
}

/**
 * The agent to open a design with: the one that made it, else the latest canvas agent working in
 * the design's folder, else the latest agent there. Several workspaces can share a folder.
 */
async function findAgent(paseo: Paseo, workspaceId: string, directory: string, preferred: string | null): Promise<Place | null> {
  const { entries } = await paseo.agents.list({
    sort: [{ key: "updated_at", direction: "desc" }],
    page: { limit: 200 },
  });
  const agents = entries
    .map((entry) => entry.agent)
    .filter((agent) => agent.workspaceId && !agent.archivedAt && !agent.internal)
    .filter((agent) => agent.workspaceId === workspaceId || agent.cwd === directory);
  const agent =
    agents.find((candidate) => candidate.id === preferred) ??
    agents.find((candidate) => candidate.workspaceId === workspaceId && candidate.labels[ENABLED_LABEL] === "true") ??
    agents.find((candidate) => candidate.labels[ENABLED_LABEL] === "true") ??
    agents.find((candidate) => candidate.workspaceId === workspaceId) ??
    agents[0];
  return agent?.workspaceId ? { agentId: agent.id, workspaceId: agent.workspaceId } : null;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Shows the agent's chat, then its Design panel. The app learns of a new agent a moment after it is created. */
async function showAgentPanel(client: PluginClientContext, navigation: Navigation, workspaceId: string, agentId: string) {
  navigation?.openAgent({ agentId });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      client.openPanel(PANEL_ID, { workspaceId, agentId });
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

export async function openDesign(input: {
  client: PluginClientContext;
  paseo: Paseo;
  navigation: Navigation;
  workspaceId: string;
  directory: string;
  slug: string;
  agentId: string | null;
}): Promise<void> {
  const { client, paseo } = input;
  let place = await findAgent(paseo, input.workspaceId, input.directory, input.agentId);
  if (!place) {
    const agent = await paseo.workspaces.ref(input.workspaceId).agents.create({
      config: await defaultConfig(paseo),
      labels: { [ENABLED_LABEL]: "true" },
    });
    place = { agentId: agent.id, workspaceId: input.workspaceId };
  }
  handOff(place.agentId, { kind: "design", slug: input.slug });
  await showAgentPanel(client, input.navigation, place.workspaceId, place.agentId);
}

/** Starts an agent on a new design in the workspace and shows its chat and canvas. */
export async function createDesign(input: {
  client: PluginClientContext;
  paseo: Paseo;
  navigation: Navigation;
  initCanvas: () => Promise<unknown>;
  workspaceId: string;
  /** The designs the workspace has now, so the canvas can tell the new one. */
  known: string[];
  kind: DesignKind;
  brief: string;
}): Promise<void> {
  const { client, paseo, workspaceId } = input;
  await input.initCanvas();
  const agent = await paseo.workspaces.ref(workspaceId).agents.create({
    config: await defaultConfig(paseo),
    title: oneLine(input.brief, 60),
    // The label attaches the design tools from the first turn.
    labels: { [ENABLED_LABEL]: "true" },
    prompt: newDesignPrompt(input.brief, input.kind),
  });
  handOff(agent.id, { kind: "new", known: input.known });
  await showAgentPanel(client, input.navigation, workspaceId, agent.id);
}
