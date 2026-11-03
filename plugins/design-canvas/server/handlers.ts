import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  addComment,
  deleteComment,
  getDesign,
  getDesignVersion,
  initCanvas,
  listDesigns,
  markCommentsSent,
  updateComment,
} from "../shared/rpc";
import * as store from "./store";
import { workspaceRoot } from "./workspace";

export function registerHandlers(server: PluginServerContext, now: () => number = Date.now): void {
  server.handle(listDesigns, async ({ workspaceId }, { paseo }) => {
    const root = await workspaceRoot(paseo, workspaceId);
    const [initialized, slugs, version] = await Promise.all([
      store.isInitialized(root),
      store.listSlugs(root),
      store.listVersion(root),
    ]);
    const designs = await Promise.all(slugs.map((slug) => store.summarize(root, slug)));
    return { initialized, designs, version };
  });

  server.handle(getDesign, async ({ workspaceId, slug }, { paseo }) =>
    store.viewDesign(await workspaceRoot(paseo, workspaceId), slug),
  );

  server.handle(getDesignVersion, async ({ workspaceId, slug }, { paseo }) => ({
    version: await store.designVersion(await workspaceRoot(paseo, workspaceId), slug),
  }));

  server.handle(addComment, async ({ workspaceId, slug, body, anchor }, { paseo }) => ({
    comment: await store.addComment(await workspaceRoot(paseo, workspaceId), slug, body, anchor, now()),
  }));

  server.handle(updateComment, async ({ workspaceId, slug, id, body, status }, { paseo }) => ({
    comment: await store.editComment(await workspaceRoot(paseo, workspaceId), slug, id, { body, status }, now()),
  }));

  server.handle(deleteComment, async ({ workspaceId, slug, id }, { paseo }) => {
    await store.deleteComment(await workspaceRoot(paseo, workspaceId), slug, id);
    return {};
  });

  server.handle(markCommentsSent, async ({ workspaceId, slug, ids }, { paseo }) => {
    await store.markSent(await workspaceRoot(paseo, workspaceId), slug, ids, now());
    return {};
  });

  server.handle(initCanvas, async ({ workspaceId }, { paseo }) => ({
    created: await store.initCanvas(await workspaceRoot(paseo, workspaceId)),
  }));
}
