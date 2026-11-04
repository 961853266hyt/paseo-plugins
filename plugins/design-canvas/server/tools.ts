import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineAgentTool, type AgentToolDefinition } from "@getpaseo/plugin/server";
import { z } from "zod";
import {
  artboardSchema,
  DESIGN_DIR,
  designKindSchema,
  isOpen,
  type Manifest,
  manifestSchema,
  MANIFEST_FILE,
  README_FILE,
  slugSchema,
} from "../shared/design";
import { formatComment, formatTweaks } from "../shared/prompts";
import { TWEAKS_CSS, tweaksListSchema } from "../shared/tweaks";
import { designDir } from "./paths";
import * as store from "./store";

function placeholderPage(title: string, artboardTitle: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${artboardTitle}</title>
<style>
  :root { --bg: #f6f5f1; --ink: #1f1e1c; --muted: #6b6963; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, sans-serif; }
  p { color: var(--muted); }
</style>
</head>
<body>
  <main data-dc-id="placeholder">
    <h1>${artboardTitle}</h1>
    <p>Placeholder: write this artboard's design here.</p>
  </main>
</body>
</html>
`;
}

function text(value: string, structuredContent?: unknown) {
  return structuredContent === undefined ? { text: value } : { text: value, structuredContent };
}

function failure(message: string) {
  return { text: message, isError: true };
}

const createInput = z.object({
  slug: slugSchema.describe("Folder name under design/, e.g. pricing-page"),
  title: z.string().min(1).max(200).describe("Shown on the canvas"),
  kind: designKindSchema.describe("prototype, wireframe, one-pager, slides or other"),
  description: z.string().max(4000).optional().describe("What the design is for"),
  artboards: z
    .array(
      artboardSchema.extend({
        file: artboardSchema.shape.file.optional().describe("Defaults to <id>.html"),
      }),
    )
    .min(1)
    .max(48)
    .describe("Screens to draw; variants of one screen share a group"),
});

export function createDesignTools(now: () => number = Date.now): AgentToolDefinition[] {
  const designCreate = defineAgentTool({
    name: "design_create",
    title: "Create a design",
    description: `Create a design on the Paseo Design canvas: makes ${DESIGN_DIR}/<slug>/ with design.json and a placeholder HTML page per artboard, which you then overwrite with the real design. Read ${DESIGN_DIR}/${README_FILE} for the conventions.`,
    input: createInput,
    async execute(input, { agent }) {
      const root = agent.cwd;
      const dir = designDir(root, input.slug);
      try {
        await stat(dir);
        return failure(`${DESIGN_DIR}/${input.slug}/ already exists. Pick another slug, or edit that design.`);
      } catch {
        // The folder is free.
      }
      const manifest: Manifest = {
        version: 1,
        title: input.title,
        kind: input.kind,
        ...(input.description ? { description: input.description } : {}),
        artboards: input.artboards.map((artboard) => ({ ...artboard, file: artboard.file ?? `${artboard.id}.html` })),
      };
      const checked = manifestSchema.safeParse(manifest);
      if (!checked.success) return failure(`Invalid design: ${checked.error.issues.map((issue) => issue.message).join("; ")}`);
      await store.initCanvas(root);
      await mkdir(dir, { recursive: true });
      await store.writeManifest(root, input.slug, checked.data);
      for (const artboard of checked.data.artboards) {
        await writeFile(path.join(dir, artboard.file), placeholderPage(checked.data.title, artboard.title), "utf8");
      }
      const files = checked.data.artboards.map((artboard) => `- ${DESIGN_DIR}/${input.slug}/${artboard.file} (${artboard.title}, ${artboard.width}px wide)`);
      return text(
        [
          `Created ${DESIGN_DIR}/${input.slug}/. It shows on the Design canvas now. Replace each placeholder page with the design:`,
          ...files,
          "",
          `Conventions are in ${DESIGN_DIR}/${README_FILE}: self-contained pages with local assets only, data-dc-id on elements the user may comment on, tunable values as CSS custom properties. To add artboards later, edit ${MANIFEST_FILE}.`,
        ].join("\n"),
        { slug: input.slug, directory: dir, manifest: checked.data },
      );
    },
  });

  const designList = defineAgentTool({
    name: "design_list",
    title: "List designs",
    description: `List the designs in ${DESIGN_DIR}/ with their artboard and open comment counts.`,
    input: z.object({}),
    async execute(_input, { agent }) {
      const slugs = await store.listSlugs(agent.cwd);
      if (slugs.length === 0) return text(`No designs in ${DESIGN_DIR}/ yet. Use design_create to start one.`, { designs: [] });
      const designs = await Promise.all(slugs.map((slug) => store.summarize(agent.cwd, slug)));
      const lines = designs.map((design) =>
        design.error
          ? `- ${design.slug}: ${design.error}`
          : `- ${design.slug}: "${design.title}" (${design.kind}), ${design.artboards} artboards, ${design.openComments} open comments`,
      );
      return text(lines.join("\n"), { designs });
    },
  });

  const designRead = defineAgentTool({
    name: "design_read",
    title: "Read a design",
    description: "Read a design's manifest, its open comments (each with the element it points at) and the tweak values the user set.",
    input: z.object({
      slug: slugSchema,
      includeResolved: z.boolean().optional().describe("Also list resolved comments"),
    }),
    async execute({ slug, includeResolved }, { agent }) {
      const read = await store.readManifest(agent.cwd, slug);
      if (!read.manifest) return failure(read.error);
      const all = (await store.readComments(agent.cwd, slug)).comments;
      const comments = includeResolved ? all : all.filter(isOpen);
      const header = `${DESIGN_DIR}/${slug}/${MANIFEST_FILE}:\n${JSON.stringify(read.manifest, null, 2)}`;
      const body = comments.length
        ? `${includeResolved ? "Comments" : "Open comments"}:\n\n${comments.map((comment) => formatComment(comment, read.manifest)).join("\n\n")}`
        : "No open comments.";
      const values = await store.readTweakValues(agent.cwd, slug).catch(() => ({}));
      const tweaks = read.manifest.tweaks?.length ? `\n\nTweak values set on the canvas:\n${formatTweaks(read.manifest, values)}` : "";
      return text(`${header}\n\n${body}${tweaks}`, { manifest: read.manifest, comments, tweakValues: values });
    },
  });

  const designResolve = defineAgentTool({
    name: "design_resolve_comments",
    title: "Resolve design comments",
    description:
      "Mark comments on a design as resolved once you have made the change, each with one line on what you changed for that comment. The canvas shows each note on its own comment.",
    input: z.object({
      slug: slugSchema,
      resolutions: z
        .array(
          z.object({
            comment: z.union([z.number().int().min(1), z.string().min(1)]).describe("Comment number (e.g. 3) or id"),
            note: z.string().min(1).max(2000).describe("One line on what you changed for this comment"),
          }),
        )
        .min(1),
    }),
    async execute({ slug, resolutions }, { agent }) {
      const result = await store.resolveComments(agent.cwd, slug, resolutions, now());
      const parts: string[] = [];
      if (result.resolved.length) parts.push(`Resolved ${result.resolved.map((n) => `#${n}`).join(", ")}.`);
      if (result.unknown.length) parts.push(`No such comments: ${result.unknown.join(", ")}.`);
      return { text: parts.join(" "), structuredContent: result, isError: result.resolved.length === 0 };
    },
  });

  const designSetTweaks = defineAgentTool({
    name: "design_set_tweaks",
    title: "Set a design's tweaks",
    description: `Declare the controls the canvas shows beside a design: each tweak drives one CSS custom property the pages read (color, range, toggle between two CSS values, or select among several). Replaces the design's whole tweak list; an empty list removes them. Values the user already set are kept when they still fit. Pages should link ${TWEAKS_CSS} last in <head>.`,
    input: z.object({ slug: slugSchema, tweaks: tweaksListSchema }),
    async execute({ slug, tweaks }, { agent }) {
      const read = await store.readManifest(agent.cwd, slug);
      if (!read.manifest) return failure(read.error);
      const { unused } = await store.setTweaks(agent.cwd, slug, tweaks);
      const lines = [tweaks.length ? `Set ${tweaks.length} tweaks on "${slug}". They show in the canvas's Tweaks panel.` : `Removed the tweaks of "${slug}".`];
      if (unused.length) lines.push(`No page reads ${unused.join(", ")} yet: use var(${unused[0]}) in the CSS, or the control will do nothing.`);
      return text(lines.join("\n"), { unused });
    },
  });

  return [designCreate, designList, designRead, designResolve, designSetTweaks];
}
