import { randomBytes, createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CANVAS_FILE,
  COMMENTS_FILE,
  type Anchor,
  type Comment,
  type CommentsFile,
  type CommentStatus,
  commentsFileSchema,
  EMPTY_COMMENTS,
  isOpen,
  MANIFEST_FILE,
  type Manifest,
  manifestSchema,
  README_FILE,
  slugSchema,
} from "../shared/design";
import type { ArtboardView, DesignSummary, DesignView } from "../shared/rpc";
import { DESIGN_GUIDE } from "./guide";
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
  const readme = path.join(dir, README_FILE);
  try {
    await stat(readme);
  } catch (error) {
    if (!isMissing(error)) throw error;
    await writeFileAtomic(readme, DESIGN_GUIDE);
  }
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
    return { slug, manifest: null, error: read.error, artboards: [], comments, version };
  }
  const allowedRoot = designRoot(root);
  const artboards = await Promise.all(
    read.manifest.artboards.map(async (artboard): Promise<ArtboardView> => {
      try {
        const file = await resolveInside(dir, dir, artboard.file);
        const { html, files } = await inlineHtml(await readFile(file, "utf8"), file, allowedRoot);
        const keys = await Promise.all([file, ...files].map(statKey));
        return { ...artboard, html, error: null, version: hash(keys) };
      } catch (error) {
        return { ...artboard, html: null, error: isMissing(error) ? `${artboard.file} is missing` : describe(error), version: "missing" };
      }
    }),
  );
  return { slug, manifest: read.manifest, error: commentsError, artboards, comments, version };
}
