import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  anchorSchema,
  artboardSchema,
  commentSchema,
  commentStatusSchema,
  designKindSchema,
  editTextSchema,
  moveStyleSchema,
  manifestSchema,
  slugSchema,
  textTargetSchema,
} from "./design";
import { tweakValueSchema } from "./tweaks";

const workspaceInput = z.object({ workspaceId: z.string().min(1) });
const designInput = workspaceInput.extend({ slug: slugSchema });

export const designSummarySchema = z.object({
  slug: slugSchema,
  title: z.string(),
  kind: designKindSchema.nullable(),
  artboards: z.number().int(),
  openComments: z.number().int(),
  /** Why design.json could not be read; null when it is fine. */
  error: z.string().nullable(),
});
export type DesignSummary = z.infer<typeof designSummarySchema>;

export const listDesigns = defineRpc({
  name: "list_designs",
  input: workspaceInput,
  output: z.object({
    /** Whether the workspace has design/canvas.json. */
    initialized: z.boolean(),
    designs: z.array(designSummarySchema),
    /** Changes whenever a design is added, removed or renamed. */
    version: z.string(),
  }),
});

export const artboardViewSchema = artboardSchema.extend({
  /** The page with its local CSS, images and fonts inlined; null when it could not be read. */
  html: z.string().nullable(),
  error: z.string().nullable(),
  /** Changes whenever the page or a file it uses changes. */
  version: z.string(),
  /** A hash of the page's own HTML, which an edit must match to be written. */
  source: z.string(),
});
export type ArtboardView = z.infer<typeof artboardViewSchema>;

export const designViewSchema = z.object({
  slug: slugSchema,
  manifest: manifestSchema.nullable(),
  /** Why design.json could not be used. */
  error: z.string().nullable(),
  artboards: z.array(artboardViewSchema),
  comments: z.array(commentSchema),
  /** The tweaks the user moved away from their defaults. */
  tweakValues: z.record(z.string(), tweakValueSchema),
  version: z.string(),
});
export type DesignView = z.infer<typeof designViewSchema>;

export const getDesign = defineRpc({
  name: "get_design",
  input: designInput,
  output: designViewSchema,
});

/** Cheap enough to poll: the same version `get_design` returns, without reading the pages. */
export const getDesignVersion = defineRpc({
  name: "get_design_version",
  input: designInput,
  output: z.object({ version: z.string() }),
});

export const addComment = defineRpc({
  name: "add_comment",
  input: designInput.extend({ body: z.string().trim().min(1).max(4000), anchor: anchorSchema }),
  output: z.object({ comment: commentSchema }),
});

export const updateComment = defineRpc({
  name: "update_comment",
  input: designInput.extend({
    id: z.string(),
    body: z.string().trim().min(1).max(4000).optional(),
    status: commentStatusSchema.optional(),
  }),
  output: z.object({ comment: commentSchema }),
});

export const deleteComment = defineRpc({
  name: "delete_comment",
  input: designInput.extend({ id: z.string() }),
  output: z.object({}),
});

/** Marks comments as handed to the agent, after the message carrying them went out. */
export const markCommentsSent = defineRpc({
  name: "mark_comments_sent",
  input: designInput.extend({ ids: z.array(z.string()).min(1) }),
  output: z.object({}),
});

/** Creates design/canvas.json and design/README.md when missing, so agents get the design tools. */
export const initCanvas = defineRpc({
  name: "init_canvas",
  input: workspaceInput,
  output: z.object({ created: z.boolean() }),
});

/** Writes a dragged element's new position into its page, if the page is still the one the canvas showed. */
export const moveElement = defineRpc({
  name: "move_element",
  input: designInput.extend({
    artboardId: slugSchema,
    dcId: z.string().min(1).max(120),
    style: moveStyleSchema,
    /** The `source` hash the canvas last saw. */
    expected: z.string(),
  }),
  output: z.object({ source: z.string(), version: z.string() }),
});

/** Remembers where an artboard was dragged; null puts it back in the automatic layout. */
export const moveArtboard = defineRpc({
  name: "move_artboard",
  input: designInput.extend({
    artboardId: slugSchema,
    position: z.object({ x: z.number().int(), y: z.number().int() }).nullable(),
  }),
  output: z.object({}),
});

/** Replaces one text node's text in its page, if the page is still the one the canvas showed. */
export const editText = defineRpc({
  name: "edit_text",
  input: designInput.extend({
    artboardId: slugSchema,
    target: textTargetSchema,
    before: editTextSchema,
    after: editTextSchema,
    expected: z.string(),
  }),
  output: z.object({ source: z.string(), version: z.string() }),
});

/** Saves tweak values and regenerates tweaks.css. */
export const saveTweaks = defineRpc({
  name: "save_tweaks",
  input: designInput.extend({
    values: z.record(z.string(), tweakValueSchema),
  }),
  output: z.object({
    values: z.record(z.string(), tweakValueSchema),
    /** Each artboard's version after the write. */
    versions: z.record(z.string(), z.string()),
  }),
});
