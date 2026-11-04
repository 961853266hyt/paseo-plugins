import { randomBytes, createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CANVAS_FILE,
  COMMENTS_FILE,
  type Anchor,
  type Artboard,
  type Comment,
  type CommentsFile,
  type CommentStatus,
  commentsFileSchema,
  EMPTY_COMMENTS,
  isOpen,
  MANIFEST_FILE,
  type Manifest,
  manifestSchema,
  type MoveStyle,
  README_FILE,
  slugSchema,
  type TextTarget,
} from "../shared/design";
import {
  prune,
  renderTweaksCss,
  type Tweak,
  TWEAKS_CSS,
  TWEAKS_FILE,
  type TweakValues,
  tweaksFileSchema,
  usesVariable,
} from "../shared/tweaks";
import type { ArtboardView, DesignSummary, DesignView } from "../shared/rpc";
import { DESIGN_GUIDE } from "./guide";
import { findByDcId, replaceText, setInlineStyle } from "./html-patch";
import { inlineHtml } from "./inline";
import { designDir, designRoot, resolveInside } from "./paths";

/** A design folder holds a few dozen files; this bounds a runaway one. */
const MAX_VERSIONED_FILES = 2000;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function formatZodError(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.map(String).join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

/** Writes through a temporary file, so a reader never sees half a file. */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, file);
}

const locks = new Map<string, Promise<unknown>>();

/** Runs `task` after every earlier task on the same key. */
function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  locks.set(key, next);
  const release = () => {
    if (locks.get(key) === next) locks.delete(key);
  };
  next.then(release, release);
  return next;
}

export async function isInitialized(root: string): Promise<boolean> {
  try {
    return (await stat(path.join(designRoot(root), CANVAS_FILE))).isFile();
  } catch {
    return false;
  }
}

/** Creates design/canvas.json and the agents' guide when missing. Returns whether it created the marker. */
export async function initCanvas(root: string): Promise<boolean> {
  const dir = designRoot(root);
  await mkdir(dir, { recursive: true });
  await refreshGuide(root);
  const marker = path.join(dir, CANVAS_FILE);
  try {
    await stat(marker);
    return false;
  } catch (error) {
    if (!isMissing(error)) throw error;
    await writeFileAtomic(marker, `${JSON.stringify({ version: 1 }, null, 2)}\n`);
    return true;
  }
}

/** How every version of the guide starts, so an older copy of it can be told from a file the user wrote. */
const GUIDE_START = "# Designs\n\nThis folder holds designs shown on the Design canvas in Paseo.";

/** Writes design/README.md when it is missing or an older version of the guide; a README of the user's stays. */
export async function refreshGuide(root: string): Promise<void> {
  const readme = path.join(designRoot(root), README_FILE);
  let current: string | null = null;
  try {
    current = await readFile(readme, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (current === DESIGN_GUIDE || (current !== null && !current.startsWith(GUIDE_START))) return;
  await writeFileAtomic(readme, DESIGN_GUIDE);
}

export type ManifestRead = { manifest: Manifest; error: null } | { manifest: null; error: string };

export async function readManifest(root: string, slug: string): Promise<ManifestRead> {
  const file = path.join(designDir(root, slug), MANIFEST_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return { manifest: null, error: isMissing(error) ? `${slug}/${MANIFEST_FILE} is missing` : describe(error) };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { manifest: null, error: `${slug}/${MANIFEST_FILE} is not valid JSON: ${describe(error)}` };
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) return { manifest: null, error: `${slug}/${MANIFEST_FILE}: ${formatZodError(parsed.error)}` };
  return { manifest: parsed.data, error: null };
}

export async function writeManifest(root: string, slug: string, manifest: Manifest): Promise<void> {
  const checked = manifestSchema.parse(manifest);
  await writeFileAtomic(path.join(designDir(root, slug), MANIFEST_FILE), `${JSON.stringify(checked, null, 2)}\n`);
}

/** The design folders: every direct child of design/ that has a design.json. */
export async function listSlugs(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(designRoot(root), { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const slugs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !slugSchema.safeParse(entry.name).success) continue;
    try {
      await stat(path.join(designRoot(root), entry.name, MANIFEST_FILE));
      slugs.push(entry.name);
    } catch {
      // A folder without design.json is not a design, e.g. systems/.
    }
  }
  return slugs.sort();
}

export async function readComments(root: string, slug: string): Promise<CommentsFile> {
  const file = path.join(designDir(root, slug), COMMENTS_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return EMPTY_COMMENTS;
    throw error;
  }
  const parsed = commentsFileSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${slug}/${COMMENTS_FILE}: ${formatZodError(parsed.error)}`);
  return parsed.data;
}

/** Reads, changes and writes comments.json, one change at a time per design. */
export function updateComments<T>(
  root: string,
  slug: string,
  change: (file: CommentsFile) => { file: CommentsFile; result: T },
): Promise<T> {
  const dir = designDir(root, slug);
  return serialize(path.join(dir, COMMENTS_FILE), async () => {
    try {
      await stat(path.join(dir, MANIFEST_FILE));
    } catch (error) {
      throw isMissing(error) ? new Error(`No design ${slug}`) : error;
    }
    const { file, result } = change(await readComments(root, slug));
    await writeFileAtomic(path.join(dir, COMMENTS_FILE), `${JSON.stringify(commentsFileSchema.parse(file), null, 2)}\n`);
    return result;
  });
}

function newCommentId(): string {
  return `c-${randomBytes(6).toString("hex")}`;
}

export function addComment(root: string, slug: string, body: string, anchor: Anchor, now: number): Promise<Comment> {
  return updateComments(root, slug, (file) => {
    const comment: Comment = { id: newCommentId(), number: file.nextNumber, body, anchor, status: "pending", createdAt: now };
    return {
      file: { ...file, nextNumber: file.nextNumber + 1, comments: [...file.comments, comment] },
      result: comment,
    };
  });
}

function replaceComment(
  file: CommentsFile,
  id: string,
  change: (comment: Comment) => Comment,
): { file: CommentsFile; result: Comment } {
  const index = file.comments.findIndex((comment) => comment.id === id);
  const current = file.comments[index];
  if (!current) throw new Error(`No comment ${id}`);
  const updated = change(current);
  const comments = [...file.comments];
  comments[index] = updated;
  return { file: { ...file, comments }, result: updated };
}

export function editComment(
  root: string,
  slug: string,
  id: string,
  edit: { body?: string; status?: CommentStatus },
  now: number,
): Promise<Comment> {
  return updateComments(root, slug, (file) =>
    replaceComment(file, id, (comment) => {
      const next: Comment = { ...comment };
      if (edit.body !== undefined) next.body = edit.body;
      if (edit.status !== undefined && edit.status !== comment.status) {
        next.status = edit.status;
        if (edit.status === "resolved") next.resolvedAt = now;
        else {
          delete next.resolvedAt;
          delete next.resolution;
        }
        if (edit.status === "pending") delete next.sentAt;
      }
      return next;
    }),
  );
}

export function deleteComment(root: string, slug: string, id: string): Promise<void> {
  return updateComments(root, slug, (file) => {
    if (!file.comments.some((comment) => comment.id === id)) throw new Error(`No comment ${id}`);
    return { file: { ...file, comments: file.comments.filter((comment) => comment.id !== id) }, result: undefined };
  });
}

export function markSent(root: string, slug: string, ids: readonly string[], now: number): Promise<void> {
  const wanted = new Set(ids);
  return updateComments(root, slug, (file) => ({
    file: {
      ...file,
      comments: file.comments.map((comment) =>
        wanted.has(comment.id) && comment.status === "pending" ? { ...comment, status: "sent" as const, sentAt: now } : comment,
      ),
    },
    result: undefined,
  }));
}

export interface Resolution {
  resolved: number[];
  unknown: string[];
}

export interface ResolveRequest {
  /** The pin number (3, "#3") or the comment id. */
  comment: string | number;
  /** What changed for this comment; the canvas shows it on the comment. */
  note?: string;
}

/** Marks comments resolved, each with its own note. */
export function resolveComments(
  root: string,
  slug: string,
  requests: readonly ResolveRequest[],
  now: number,
): Promise<Resolution> {
  return updateComments(root, slug, (file) => {
    const resolved: number[] = [];
    const unknown: string[] = [];
    const comments = [...file.comments];
    for (const { comment: ref, note } of requests) {
      const index = comments.findIndex((comment) =>
        typeof ref === "number" ? comment.number === ref : comment.id === ref || `#${comment.number}` === ref,
      );
      const current = comments[index];
      if (!current) {
        unknown.push(String(ref));
        continue;
      }
      comments[index] = { ...current, status: "resolved", resolvedAt: now, ...(note ? { resolution: note } : {}) };
      resolved.push(current.number);
    }
    return { file: { ...file, comments }, result: { resolved, unknown } };
  });
}

async function statKey(file: string): Promise<string> {
  try {
    const info = await stat(file);
    return `${file}:${info.size}:${info.mtimeMs}`;
  } catch {
    return `${file}:missing`;
  }
}

function hash(parts: readonly string[]): string {
  return createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 16);
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_VERSIONED_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

/** Changes when any file of the design, or of a design system it may use, changes. */
export async function designVersion(root: string, slug: string): Promise<string> {
  const files: string[] = [];
  await walk(designDir(root, slug), files);
  await walk(path.join(designRoot(root), "systems"), files);
  files.sort();
  return hash(await Promise.all(files.map(statKey)));
}

export async function listVersion(root: string): Promise<string> {
  const slugs = await listSlugs(root);
  const keys = await Promise.all(slugs.map((slug) => statKey(path.join(designDir(root, slug), MANIFEST_FILE))));
  keys.push(await statKey(path.join(designRoot(root), CANVAS_FILE)));
  return hash(keys);
}

export async function summarize(root: string, slug: string): Promise<DesignSummary> {
  const [read, comments] = await Promise.all([
    readManifest(root, slug),
    readComments(root, slug).catch(() => EMPTY_COMMENTS),
  ]);
  const openComments = comments.comments.filter(isOpen).length;
  if (!read.manifest) return { slug, title: slug, kind: null, artboards: 0, openComments, error: read.error };
  return {
    slug,
    title: read.manifest.title,
    kind: read.manifest.kind,
    artboards: read.manifest.artboards.length,
    openComments,
    error: null,
  };
}

export async function viewDesign(root: string, slug: string): Promise<DesignView> {
  const dir = designDir(root, slug);
  const [read, version] = await Promise.all([readManifest(root, slug), designVersion(root, slug)]);
  let comments: Comment[] = [];
  let commentsError: string | null = null;
  try {
    comments = (await readComments(root, slug)).comments;
  } catch (error) {
    commentsError = describe(error);
  }
  if (!read.manifest) {
    return { slug, manifest: null, error: read.error, artboards: [], comments, tweakValues: {}, version };
  }
  const artboards = await Promise.all(read.manifest.artboards.map((artboard) => renderArtboard(root, slug, artboard)));
  const tweakValues = prune(read.manifest.tweaks ?? [], await readTweakValues(root, slug).catch(() => ({})));
  return { slug, manifest: read.manifest, error: commentsError, artboards, comments, tweakValues, version };
}

function contentHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/** One artboard as the canvas shows it: the page with its local files inlined. */
async function renderArtboard(root: string, slug: string, artboard: Artboard): Promise<ArtboardView> {
  const dir = designDir(root, slug);
  try {
    const file = await resolveInside(dir, dir, artboard.file);
    const source = await readFile(file, "utf8");
    const { html, files } = await inlineHtml(source, file, designRoot(root));
    const keys = await Promise.all([file, ...files].map(statKey));
    return { ...artboard, html, error: null, version: hash(keys), source: contentHash(source) };
  } catch (error) {
    const message = isMissing(error) ? `${artboard.file} is missing` : describe(error);
    return { ...artboard, html: null, error: message, version: "missing", source: "missing" };
  }
}

/** Thrown when the page changed on disk since the canvas read it, e.g. because the agent edited it. */
export class ConflictError extends Error {}

/**
 * Rewrites one artboard's page, after earlier writes to it. The write is refused when the page no
 * longer matches what the canvas showed (`expected` is its `source` hash).
 */
function patchPage(
  root: string,
  slug: string,
  artboardId: string,
  expected: string,
  patch: (text: string, artboard: Artboard) => string,
): Promise<{ source: string; version: string }> {
  const dir = designDir(root, slug);
  return serialize(path.join(dir, `#artboard:${artboardId}`), async () => {
    const read = await readManifest(root, slug);
    if (!read.manifest) throw new Error(read.error);
    const artboard = read.manifest.artboards.find((candidate) => candidate.id === artboardId);
    if (!artboard) throw new Error(`No artboard ${artboardId}`);
    const file = await resolveInside(dir, dir, artboard.file);
    const text = await readFile(file, "utf8");
    if (contentHash(text) !== expected) throw new ConflictError(`${artboard.file} changed on disk`);
    await writeFileAtomic(file, patch(text, artboard));
    const view = await renderArtboard(root, slug, artboard);
    return { source: view.source, version: view.version };
  });
}

/** Writes a moved element's position into the inline style of the element with this data-dc-id. */
export function moveElement(
  root: string,
  slug: string,
  artboardId: string,
  dcId: string,
  style: MoveStyle,
  expected: string,
): Promise<{ source: string; version: string }> {
  return patchPage(root, slug, artboardId, expected, (text, artboard) => {
    const tags = findByDcId(text, dcId);
    if (tags.length === 0) throw new Error(`No element with data-dc-id="${dcId}" in ${artboard.file}`);
    if (tags.length > 1) throw new Error(`${tags.length} elements share data-dc-id="${dcId}" in ${artboard.file}`);
    const properties = Object.fromEntries(Object.entries(style).filter((entry): entry is [string, string] => entry[1] !== undefined));
    return setInlineStyle(text, tags[0]!, properties);
  });
}

/** Replaces one text node's text in the page, if the source still has `before` there. */
export function editText(
  root: string,
  slug: string,
  artboardId: string,
  target: TextTarget,
  before: string,
  after: string,
  expected: string,
): Promise<{ source: string; version: string }> {
  return patchPage(root, slug, artboardId, expected, (text) => replaceText(text, target, before, after));
}

/** Pins an artboard where it was dragged, or with null returns it to the automatic layout. */
export function moveArtboard(
  root: string,
  slug: string,
  artboardId: string,
  position: { x: number; y: number } | null,
): Promise<void> {
  return serialize(path.join(designDir(root, slug), MANIFEST_FILE), async () => {
    const read = await readManifest(root, slug);
    if (!read.manifest) throw new Error(read.error);
    if (!read.manifest.artboards.some((artboard) => artboard.id === artboardId)) throw new Error(`No artboard ${artboardId}`);
    const artboards = read.manifest.artboards.map((artboard) => {
      if (artboard.id !== artboardId) return artboard;
      const { x: _x, y: _y, ...rest } = artboard;
      return position ? { ...rest, x: Math.round(position.x), y: Math.round(position.y) } : rest;
    });
    await writeManifest(root, slug, { ...read.manifest, artboards });
  });
}

// ---- Tweaks ------------------------------------------------------------------------------

export async function readTweakValues(root: string, slug: string): Promise<TweakValues> {
  let text: string;
  try {
    text = await readFile(path.join(designDir(root, slug), TWEAKS_FILE), "utf8");
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
  const parsed = tweaksFileSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${slug}/${TWEAKS_FILE}: ${formatZodError(parsed.error)}`);
  return parsed.data.values;
}

async function writeTweakFiles(root: string, slug: string, tweaks: readonly Tweak[], values: TweakValues): Promise<void> {
  const dir = designDir(root, slug);
  const pruned = prune(tweaks, values);
  await writeFileAtomic(path.join(dir, TWEAKS_FILE), `${JSON.stringify(tweaksFileSchema.parse({ version: 1, values: pruned }), null, 2)}\n`);
  await writeFileAtomic(path.join(dir, TWEAKS_CSS), renderTweaksCss(tweaks, pruned));
}

/**
 * Saves the tweak values and regenerates tweaks.css. Returns each artboard's new version, since a
 * page that links tweaks.css changes with it.
 */
export function saveTweaks(
  root: string,
  slug: string,
  values: TweakValues,
): Promise<{ values: TweakValues; versions: Record<string, string> }> {
  return serialize(path.join(designDir(root, slug), MANIFEST_FILE), async () => {
    const read = await readManifest(root, slug);
    if (!read.manifest) throw new Error(read.error);
    const manifest = read.manifest;
    const saved = prune(manifest.tweaks ?? [], values);
    await writeTweakFiles(root, slug, manifest.tweaks ?? [], saved);
    const views = await Promise.all(manifest.artboards.map((artboard) => renderArtboard(root, slug, artboard)));
    return { values: saved, versions: Object.fromEntries(views.map((view) => [view.id, view.version])) };
  });
}

/** Declares a design's tweaks, keeping the values that still fit. Returns the variables no page uses. */
export function setTweaks(root: string, slug: string, tweaks: Tweak[]): Promise<{ unused: string[] }> {
  return serialize(path.join(designDir(root, slug), MANIFEST_FILE), async () => {
    const read = await readManifest(root, slug);
    if (!read.manifest) throw new Error(read.error);
    const { tweaks: _old, ...rest } = read.manifest;
    const manifest: Manifest = tweaks.length ? { ...rest, tweaks } : rest;
    await writeManifest(root, slug, manifest);
    await writeTweakFiles(root, slug, tweaks, await readTweakValues(root, slug).catch(() => ({})));
    return { unused: await unusedVariables(root, slug, manifest) };
  });
}

/** Tweak variables that no artboard page (or a stylesheet it pulls in) refers to. */
export async function unusedVariables(root: string, slug: string, manifest: Manifest): Promise<string[]> {
  if (!manifest.tweaks?.length) return [];
  const views = await Promise.all(manifest.artboards.map((artboard) => renderArtboard(root, slug, artboard)));
  return manifest.tweaks.map((tweak) => tweak.var).filter((name) => !views.some((view) => usesVariable(view.html ?? "", name)));
}
