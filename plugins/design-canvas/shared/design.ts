import { z } from "zod";

/** Everything the plugin reads or writes lives under this folder of the workspace. */
export const DESIGN_DIR = "design";
/** Marks a workspace that uses the canvas; its agents get the design tools. */
export const CANVAS_FILE = "canvas.json";
export const MANIFEST_FILE = "design.json";
export const COMMENTS_FILE = "comments.json";
export const README_FILE = "README.md";

/** Artboard sizes in CSS pixels. A design may use any size; these are the presets agents are told about. */
export const SIZE_PRESETS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1194 },
  mobile: { width: 390, height: 844 },
} as const;

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const slugSchema = z
  .string()
  .regex(SLUG, "Use lowercase letters, digits and dashes, starting with a letter or digit (at most 63)");

export const designKindSchema = z.enum(["prototype", "wireframe", "one-pager", "slides", "other"]);
export type DesignKind = z.infer<typeof designKindSchema>;

export const artboardSchema = z.object({
  id: slugSchema,
  title: z.string().min(1).max(120),
  /** An HTML file next to design.json. */
  file: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/, "An .html file name in the design folder, without a path"),
  width: z.number().int().min(160).max(4096),
  /** A fixed screen height; omit it to show the whole page at its own height. */
  height: z.number().int().min(120).max(8192).optional(),
  /** Variants of one screen share a group and sit side by side in one row. */
  group: z.string().min(1).max(120).optional(),
});
export type Artboard = z.infer<typeof artboardSchema>;

export const manifestSchema = z
  .object({
    version: z.literal(1),
    title: z.string().min(1).max(200),
    kind: designKindSchema,
    description: z.string().max(4000).optional(),
    artboards: z.array(artboardSchema).min(1).max(48),
  })
  .superRefine((manifest, ctx) => {
    const ids = new Set<string>();
    const files = new Set<string>();
    manifest.artboards.forEach((artboard, index) => {
      if (ids.has(artboard.id)) {
        ctx.addIssue({ code: "custom", path: ["artboards", index, "id"], message: `Duplicate artboard id ${artboard.id}` });
      }
      if (files.has(artboard.file)) {
        ctx.addIssue({ code: "custom", path: ["artboards", index, "file"], message: `Two artboards use ${artboard.file}` });
      }
      ids.add(artboard.id);
      files.add(artboard.file);
    });
  });
export type Manifest = z.infer<typeof manifestSchema>;

export const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type Rect = z.infer<typeof rectSchema>;

/** Where a comment points. Found again by `dcId`, then `path`, then the remembered position. */
export const anchorSchema = z.object({
  artboardId: slugSchema,
  /** The element's `data-dc-id`, when the agent gave it one. */
  dcId: z.string().max(120).optional(),
  /** A CSS selector from the body, e.g. `body > main:nth-of-type(1) > button:nth-of-type(2)`. */
  path: z.string().max(2000),
  tag: z.string().max(40),
  /** The start of the element's text. */
  text: z.string().max(200),
  /** The start of the element's HTML. */
  html: z.string().max(1200),
  /** The element's box in the page when the comment was written. */
  rect: rectSchema,
});
export type Anchor = z.infer<typeof anchorSchema>;

export const commentStatusSchema = z.enum(["pending", "sent", "resolved"]);
export type CommentStatus = z.infer<typeof commentStatusSchema>;

export const commentSchema = z.object({
  id: z.string().regex(/^c-[a-z0-9]{4,32}$/),
  /** Shown on the pin; never reused within a design. */
  number: z.number().int().min(1),
  body: z.string().min(1).max(4000),
  anchor: anchorSchema,
  status: commentStatusSchema,
  createdAt: z.number(),
  sentAt: z.number().optional(),
  resolvedAt: z.number().optional(),
  /** What the agent says it changed. */
  resolution: z.string().max(2000).optional(),
});
export type Comment = z.infer<typeof commentSchema>;

export const commentsFileSchema = z.object({
  version: z.literal(1),
  nextNumber: z.number().int().min(1),
  comments: z.array(commentSchema),
});
export type CommentsFile = z.infer<typeof commentsFileSchema>;

export const EMPTY_COMMENTS: CommentsFile = { version: 1, nextNumber: 1, comments: [] };

export const canvasFileSchema = z.looseObject({ version: z.literal(1) });

/** Open comments are the ones the agent still has to act on. */
export function isOpen(comment: Comment): boolean {
  return comment.status !== "resolved";
}
