import { type Comment, DESIGN_DIR, type Manifest } from "./design";

/** The agent label that gives an agent the design tools even before its workspace uses the canvas. */
export const ENABLED_LABEL = "design-canvas/enabled";

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One comment as the agent reads it: where it points, then what the user asked. */
export function formatComment(comment: Comment, manifest: Manifest | null): string {
  const { anchor } = comment;
  const artboard = manifest?.artboards.find((candidate) => candidate.id === anchor.artboardId);
  const where = artboard ? `${artboard.title} (${artboard.file})` : anchor.artboardId;
  const element = anchor.dcId ? `[data-dc-id="${anchor.dcId}"]` : anchor.path;
  const lines = [
    `#${comment.number} on ${where}`,
    `  Element: <${anchor.tag}> ${element}`,
  ];
  if (anchor.text) lines.push(`  Text: "${oneLine(anchor.text, 120)}"`);
  lines.push(`  Comment: ${comment.body.replace(/\n/g, "\n    ")}`);
  if (comment.status === "resolved" && comment.resolution) lines.push(`  Resolved: ${oneLine(comment.resolution, 200)}`);
  return lines.join("\n");
}

/** The message the canvas sends when the user hands over a batch of comments. */
export function commentsPrompt(slug: string, manifest: Manifest | null, comments: readonly Comment[]): string {
  const title = manifest ? `"${manifest.title}" ` : "";
  return [
    `Please revise the design ${title}in ${DESIGN_DIR}/${slug}/ for these ${comments.length === 1 ? "comment" : `${comments.length} comments`} from the Design canvas:`,
    "",
    comments.map((comment) => formatComment(comment, manifest)).join("\n\n"),
    "",
    `Keep existing data-dc-id attributes. When done, call design_resolve_comments for "${slug}" with the numbers you handled and one line on what you changed. Without that tool, mark them resolved in ${DESIGN_DIR}/${slug}/comments.json as ${DESIGN_DIR}/README.md describes.`,
  ].join("\n");
}

/** The message that starts a new design. */
export function newDesignPrompt(brief: string): string {
  return [
    "Create a new design on the Design canvas:",
    "",
    brief.trim(),
    "",
    `Use design_create to set it up (read ${DESIGN_DIR}/README.md for the conventions), then write each artboard as a complete, self-contained HTML page with local CSS and assets only. Give the elements I might comment on a data-dc-id. When the request leaves room for interpretation, show 2 or 3 variants as artboards in one group.`,
  ].join("\n");
}
