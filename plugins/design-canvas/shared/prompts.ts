import { type Comment, DESIGN_DIR, type Manifest } from "./design";
import { cssValue, effectiveValue, prune, TWEAKS_CSS, type TweakValues } from "./tweaks";

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
    `Keep existing data-dc-id attributes. When done, call design_resolve_comments for "${slug}" with each comment you handled and one line on what you changed for it. Without that tool, mark them resolved in ${DESIGN_DIR}/${slug}/comments.json as ${DESIGN_DIR}/README.md describes.`,
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

/** The tweaks with their current values, one per line, for the agent. */
export function formatTweaks(manifest: Manifest, values: TweakValues): string {
  const tweaks = manifest.tweaks ?? [];
  if (tweaks.length === 0) return "No tweaks declared.";
  return tweaks
    .map((tweak) => {
      const value = effectiveValue(tweak, values);
      const changed = tweak.id in values ? ` (default ${cssValue(tweak, tweak.default)})` : "";
      return `- ${tweak.id} "${tweak.label}": ${tweak.var} = ${cssValue(tweak, value)}${changed}`;
    })
    .join("\n");
}

/** Asks the agent to make the values set on the canvas the design's own, so it keeps its look without them. */
export function applyTweaksPrompt(slug: string, manifest: Manifest, values: TweakValues): string {
  const tweaks = manifest.tweaks ?? [];
  const changed = prune(tweaks, values);
  const lines = tweaks
    .filter((tweak) => tweak.id in changed)
    .map((tweak) => `- ${tweak.id} "${tweak.label}": ${tweak.var} = ${cssValue(tweak, changed[tweak.id]!)} (now ${cssValue(tweak, tweak.default)})`);
  return [
    `Please make these tweak values from the Design canvas part of the design "${manifest.title}" in ${DESIGN_DIR}/${slug}/:`,
    "",
    lines.join("\n"),
    "",
    `Set each variable to its new value in the pages' CSS and make it that tweak's default with design_set_tweaks (or in design.json), so the design looks the same without ${TWEAKS_CSS}. Change nothing else.`,
  ].join("\n");
}

/** Asks the agent to pick what is worth tuning in a design and expose it as tweaks. */
export function tweaksPrompt(slug: string, manifest: Manifest | null): string {
  const title = manifest ? `"${manifest.title}" ` : "";
  const existing = manifest?.tweaks?.length ? ` It already has ${manifest.tweaks.map((tweak) => tweak.id).join(", ")}; keep those and add what is missing.` : "";
  return [
    `Please add tweaks to the design ${title}in ${DESIGN_DIR}/${slug}/: the 3 to 6 values most worth tuning by hand, such as the accent color, spacing, corner radius, type scale or a layout switch.${existing}`,
    "",
    `Make the pages read each one from a CSS custom property on :root, declare them with design_set_tweaks (or in the "tweaks" list of design.json, as ${DESIGN_DIR}/README.md describes), keep each default equal to the value in the CSS, and link ${TWEAKS_CSS} last in each page's <head>. Don't change how the design looks at the defaults.`,
  ].join("\n");
}
