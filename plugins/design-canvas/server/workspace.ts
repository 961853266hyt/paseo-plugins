import type { PluginHandlerContext } from "@getpaseo/plugin/server";

type PaseoApi = PluginHandlerContext["paseo"];

const TTL_MS = 30_000;
const cache = new Map<string, { directory: string; at: number }>();

/** The workspace's directory on this host, asked of the daemon rather than trusted from the app. */
export async function workspaceRoot(paseo: PaseoApi, workspaceId: string): Promise<string> {
  const cached = cache.get(workspaceId);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.directory;
  const handle = paseo.workspaces.ref(workspaceId);
  await handle.refresh();
  const directory = handle.directory;
  if (!directory) throw new Error(`Workspace ${workspaceId} has no directory on this host`);
  cache.set(workspaceId, { directory, at: Date.now() });
  return directory;
}
