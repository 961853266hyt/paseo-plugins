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

export interface WorkspaceEntry {
  id: string;
  directory: string;
  project: string;
  name: string;
}

/** The workspaces on this host that the user can see, most recently active first. */
export async function listWorkspaces(paseo: PaseoApi): Promise<WorkspaceEntry[]> {
  const out: WorkspaceEntry[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await paseo.workspaces.list({
      sort: [{ key: "activity_at", direction: "desc" }],
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const workspace of result.entries) {
      if (workspace.archivingAt || workspace.background) continue;
      const directory = workspace.workspaceDirectory ?? workspace.projectRootPath;
      if (!directory || seen.has(directory)) continue;
      seen.add(directory);
      cache.set(workspace.id, { directory, at: Date.now() });
      out.push({ id: workspace.id, directory, project: workspace.projectDisplayName, name: workspace.name });
    }
    cursor = result.pageInfo.nextCursor ?? undefined;
    if (!result.pageInfo.hasMore || !cursor) break;
  }
  return out;
}
