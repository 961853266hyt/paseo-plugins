import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  addComment,
  deleteComment,
  deleteDesign,
  editText,
  renameDesign,
  getDesign,
  getDesignVersion,
  initCanvas,
  listDesigns,
  markCommentsSent,
  moveArtboard,
  moveElement,
  saveTweaks,
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
    // Agents read the guide; keep it current when the plugin is updated.
    if (initialized) await store.refreshGuide(root).catch(() => {});
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

  server.handle(moveElement, async ({ workspaceId, slug, artboardId, dcId, style, expected }, { paseo }) =>
    store.moveElement(await workspaceRoot(paseo, workspaceId), slug, artboardId, dcId, style, expected),
  );

  server.handle(moveArtboard, async ({ workspaceId, slug, artboardId, position }, { paseo }) => {
    await store.moveArtboard(await workspaceRoot(paseo, workspaceId), slug, artboardId, position);
    return {};
  });

  server.handle(renameDesign, async ({ workspaceId, slug, title }, { paseo }) =>
    store.renameDesign(await workspaceRoot(paseo, workspaceId), slug, title),
  );

  server.handle(deleteDesign, async ({ workspaceId, slug }, { paseo }) =>
    store.trashDesign(await workspaceRoot(paseo, workspaceId), slug, now()),
  );

  server.handle(editText, async ({ workspaceId, slug, artboardId, target, before, after, expected }, { paseo }) =>
    store.editText(await workspaceRoot(paseo, workspaceId), slug, artboardId, target, before, after, expected),
  );

  server.handle(saveTweaks, async ({ workspaceId, slug, values }, { paseo }) =>
    store.saveTweaks(await workspaceRoot(paseo, workspaceId), slug, values),
  );

  server.handle(initCanvas, async ({ workspaceId }, { paseo }) => ({
    created: await store.initCanvas(await workspaceRoot(paseo, workspaceId)),
  }));
}
