import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { resolveInside } from "./paths";

/** An asset bigger than this keeps its URL, which the canvas then blocks. */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_DEPTH = 4;

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

export interface InlineResult {
  html: string;
  /** Every local file the page pulled in, for versioning. */
  files: string[];
}

/** Local means a relative path: no scheme, no `//host`, no fragment-only or data reference. */
export function isLocalReference(reference: string): boolean {
  const trimmed = reference.trim();
  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("//")) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}

function stripQuery(reference: string): string {
  return reference.trim().replace(/[?#].*$/, "");
}

function unquote(value: string): string {
  const first = value[0];
  if ((first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1);
  return value;
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i").exec(tag);
  return match?.[1] ? unquote(match[1]) : null;
}

async function replaceAsync(
  text: string,
  pattern: RegExp,
  replacer: (match: RegExpExecArray) => Promise<string>,
): Promise<string> {
  const parts: string[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(last, match.index));
    parts.push(await replacer(match as RegExpExecArray));
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return parts.join("");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Inlines a page's local CSS, scripts, images, fonts and media, so it renders in an iframe that
 * can reach nothing. Only files inside `allowedRoot` are read; anything else keeps its URL.
 */
export async function inlineHtml(html: string, htmlFile: string, allowedRoot: string): Promise<InlineResult> {
  const files = new Set<string>();

  async function load(fromDir: string, reference: string): Promise<{ file: string; bytes: Buffer } | null> {
    if (!isLocalReference(reference)) return null;
    try {
      const file = await resolveInside(allowedRoot, fromDir, decodeURI(stripQuery(reference)));
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_ASSET_BYTES) return null;
      files.add(file);
      return { file, bytes: await readFile(file) };
    } catch {
      return null;
    }
  }

  async function dataUrl(fromDir: string, reference: string): Promise<string | null> {
    const loaded = await load(fromDir, reference);
    if (!loaded) return null;
    const mime = MIME[path.extname(loaded.file).toLowerCase()] ?? "application/octet-stream";
    return `data:${mime};base64,${loaded.bytes.toString("base64")}`;
  }

  async function inlineCss(css: string, fromDir: string, depth: number): Promise<string> {
    let out = css;
    if (depth < MAX_IMPORT_DEPTH) {
      out = await replaceAsync(
        out,
        /@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?\s*([^;]*);/gi,
        async (match) => {
          const reference = match[2] ?? "";
          const loaded = await load(fromDir, reference);
          if (!loaded) return match[0];
          const media = (match[3] ?? "").trim();
          const inner = await inlineCss(loaded.bytes.toString("utf8"), path.dirname(loaded.file), depth + 1);
          return media ? `@media ${media} {\n${inner}\n}` : inner;
        },
      );
    }
    return replaceAsync(out, /url\(\s*(["']?)([^"')]+)\1\s*\)/gi, async (match) => {
      const url = await dataUrl(fromDir, match[2] ?? "");
      return url ? `url("${url}")` : match[0];
    });
  }

  const pageDir = path.dirname(htmlFile);
  let out = html;

  out = await replaceAsync(out, /<link\b[^>]*>/gi, async (match) => {
    const tag = match[0];
    const rel = (attribute(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    const href = attribute(tag, "href");
    if (!href || !rel.includes("stylesheet")) {
      if (href && rel.includes("icon")) {
        const url = await dataUrl(pageDir, href);
        if (url) return tag.replace(/\shref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, ` href="${escapeAttribute(url)}"`);
      }
      return tag;
    }
    const loaded = await load(pageDir, href);
    if (!loaded) return tag;
    const css = await inlineCss(loaded.bytes.toString("utf8"), path.dirname(loaded.file), 0);
    const media = attribute(tag, "media");
    const mediaAttr = media ? ` media="${escapeAttribute(media)}"` : "";
    return `<style data-dc-href="${escapeAttribute(href)}"${mediaAttr}>\n${css}\n</style>`;
  });

  out = await replaceAsync(out, /<script\b([^>]*)>([\s\S]*?)<\/script>/gi, async (match) => {
    const attrs = match[1] ?? "";
    const src = attribute(` ${attrs}`, "src");
    if (!src) return match[0];
    const loaded = await load(pageDir, src);
    if (!loaded) return match[0];
    const rest = attrs.replace(/\ssrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, "");
    const code = loaded.bytes.toString("utf8").replace(/<\/script/gi, "<\\/script");
    return `<script${rest} data-dc-src="${escapeAttribute(src)}">\n${code}\n</script>`;
  });

  out = await replaceAsync(
    out,
    /(<(?:img|source|video|audio|track|input|image|use)\b[^>]*?\s)(src|poster|href|xlink:href)\s*=\s*("[^"]*"|'[^']*')/gi,
    async (match) => {
      const url = await dataUrl(pageDir, unquote(match[3] ?? ""));
      return url ? `${match[1]}${match[2]}="${escapeAttribute(url)}"` : match[0];
    },
  );

  out = await replaceAsync(out, /<style\b([^>]*)>([\s\S]*?)<\/style>/gi, async (match) => {
    if (/data-dc-href/.test(match[1] ?? "")) return match[0];
    return `<style${match[1] ?? ""}>${await inlineCss(match[2] ?? "", pageDir, 0)}</style>`;
  });

  out = await replaceAsync(out, /\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, async (match) => {
    const quoted = match[1] ?? '""';
    const quote = quoted[0] ?? '"';
    const css = await inlineCss(quoted.slice(1, -1), pageDir, MAX_IMPORT_DEPTH);
    return ` style=${quote}${css.replace(new RegExp(quote, "g"), quote === '"' ? "&quot;" : "&#39;")}${quote}`;
  });

  return { html: out, files: [...files] };
}
