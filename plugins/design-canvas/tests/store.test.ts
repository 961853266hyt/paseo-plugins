import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Anchor } from "../shared/design";
import { inlineHtml, isLocalReference } from "../server/inline";
import * as store from "../server/store";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "design-canvas-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const anchor: Anchor = {
  artboardId: "desktop",
  dcId: "cta",
  path: "body > button:nth-of-type(1)",
  tag: "button",
  text: "Buy now",
  html: "<button data-dc-id=\"cta\">Buy now</button>",
  rect: { x: 10, y: 20, width: 100, height: 40 },
};

async function makeDesign(slug = "pricing", html = "<!doctype html><p>Hi</p>"): Promise<void> {
  const dir = path.join(root, "design", slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "design.json"),
    JSON.stringify({
      version: 1,
      title: "Pricing",
      kind: "prototype",
      artboards: [{ id: "desktop", title: "Desktop", file: "desktop.html", width: 1440 }],
    }),
  );
  await writeFile(path.join(dir, "desktop.html"), html);
}

describe("canvas marker", () => {
  test("creates canvas.json and the guide once", async () => {
    expect(await store.isInitialized(root)).toBe(false);
    expect(await store.initCanvas(root)).toBe(true);
    expect(await store.initCanvas(root)).toBe(false);
    expect(await store.isInitialized(root)).toBe(true);
    expect(await readFile(path.join(root, "design", "README.md"), "utf8")).toContain("data-dc-id");
  });
});

describe("home", () => {
  test("remembers the agent of each design and keeps the rest of canvas.json", async () => {
    await store.initCanvas(root);
    expect(await store.readDesignAgents(root)).toEqual({});
    await Promise.all([store.rememberDesignAgent(root, "pricing", "a1"), store.rememberDesignAgent(root, "onboarding", "a2")]);
    expect(await store.readDesignAgents(root)).toEqual({ pricing: "a1", onboarding: "a2" });
    expect(await store.isInitialized(root)).toBe(true);
    expect(JSON.parse(await readFile(path.join(root, "design", "canvas.json"), "utf8")).version).toBe(1);
  });

  test("gives the first artboard as the cover and the latest change time", async () => {
    await makeDesign("pricing", "<!doctype html><p>Cover</p>");
    const cover = await store.coverView(root, "pricing");
    expect(cover?.id).toBe("desktop");
    expect(cover?.html).toContain("Cover");
    expect(await store.designUpdatedAt(root, "pricing")).toBeGreaterThan(0);
    expect(await store.coverView(root, "missing")).toBeNull();
  });
});

describe("designs", () => {
  test("lists folders with a design.json, and reports a broken manifest", async () => {
    await makeDesign("pricing");
    await mkdir(path.join(root, "design", "systems"), { recursive: true });
    await mkdir(path.join(root, "design", "broken"), { recursive: true });
    await writeFile(path.join(root, "design", "broken", "design.json"), "{ nope");
    expect(await store.listSlugs(root)).toEqual(["broken", "pricing"]);
    expect((await store.summarize(root, "pricing")).artboards).toBe(1);
    expect((await store.summarize(root, "broken")).error).toMatch(/not valid JSON/);
  });

  test("rejects duplicate artboard ids", async () => {
    await makeDesign();
    const file = path.join(root, "design", "pricing", "design.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.artboards.push({ ...manifest.artboards[0], file: "other.html" });
    await writeFile(file, JSON.stringify(manifest));
    expect((await store.readManifest(root, "pricing")).error).toMatch(/Duplicate artboard id desktop/);
  });

  test("view inlines the page and reports a missing artboard file", async () => {
    await makeDesign();
    const view = await store.viewDesign(root, "pricing");
    expect(view.artboards[0]?.html).toContain("<p>Hi</p>");
    await rm(path.join(root, "design", "pricing", "desktop.html"));
    const missing = await store.viewDesign(root, "pricing");
    expect(missing.artboards[0]?.html).toBeNull();
    expect(missing.artboards[0]?.error).toMatch(/desktop.html is missing/);
  });

  test("the version changes when a page changes", async () => {
    await makeDesign();
    const before = await store.designVersion(root, "pricing");
    await new Promise((resolve) => setTimeout(resolve, 15));
    await writeFile(path.join(root, "design", "pricing", "desktop.html"), "<p>Changed</p>");
    expect(await store.designVersion(root, "pricing")).not.toBe(before);
  });
});

describe("comments", () => {
  test("numbers comments, marks them sent and resolves them by number", async () => {
    await makeDesign();
    const first = await store.addComment(root, "pricing", "Bigger", anchor, 1);
    const second = await store.addComment(root, "pricing", "Blue", anchor, 2);
    expect([first.number, second.number]).toEqual([1, 2]);
    await store.markSent(root, "pricing", [first.id], 3);
    const resolution = await store.resolveComments(root, "pricing", [{ comment: 1, note: "Made it bigger" }, { comment: "#9" }], 4);
    expect(resolution).toEqual({ resolved: [1], unknown: ["#9"] });
    const file = await store.readComments(root, "pricing");
    expect(file.comments.map((comment) => comment.status)).toEqual(["resolved", "pending"]);
    expect(file.comments[0]?.resolution).toBe("Made it bigger");
  });

  test("numbers are not reused after a delete, and reopening clears the resolution", async () => {
    await makeDesign();
    const first = await store.addComment(root, "pricing", "One", anchor, 1);
    await store.deleteComment(root, "pricing", first.id);
    const second = await store.addComment(root, "pricing", "Two", anchor, 2);
    expect(second.number).toBe(2);
    await store.resolveComments(root, "pricing", [{ comment: second.id, note: "Done" }], 3);
    const reopened = await store.editComment(root, "pricing", second.id, { status: "pending" }, 4);
    expect(reopened.resolution).toBeUndefined();
    expect(reopened.resolvedAt).toBeUndefined();
  });

  test("concurrent adds keep every comment", async () => {
    await makeDesign();
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.addComment(root, "pricing", `c${i}`, anchor, i)));
    const file = await store.readComments(root, "pricing");
    expect(file.comments).toHaveLength(10);
    expect(new Set(file.comments.map((comment) => comment.number)).size).toBe(10);
  });

  test("a comment on a design that does not exist fails", async () => {
    await expect(store.addComment(root, "ghost", "x", anchor, 1)).rejects.toThrow("No design ghost");
  });
});

describe("inlining", () => {
  test("local references are relative paths only", () => {
    expect(isLocalReference("style.css")).toBe(true);
    expect(isLocalReference("../systems/a/tokens.css")).toBe(true);
    expect(isLocalReference("https://cdn.example.com/a.css")).toBe(false);
    expect(isLocalReference("//cdn.example.com/a.css")).toBe(false);
    expect(isLocalReference("data:image/png;base64,AAAA")).toBe(false);
    expect(isLocalReference("#frag")).toBe(false);
  });

  test("inlines stylesheets with imports and urls, scripts and images", async () => {
    const dir = path.join(root, "design", "pricing");
    const systems = path.join(root, "design", "systems", "brand");
    await mkdir(dir, { recursive: true });
    await mkdir(systems, { recursive: true });
    await writeFile(path.join(systems, "tokens.css"), ":root { --accent: red; }");
    await writeFile(path.join(dir, "style.css"), '@import "../systems/brand/tokens.css";\nbody { background: url(bg.png); }');
    await writeFile(path.join(dir, "bg.png"), Buffer.from([1, 2, 3]));
    await writeFile(path.join(dir, "app.js"), "console.log('</script>')");
    const html = [
      '<link rel="stylesheet" href="style.css">',
      '<link rel="stylesheet" href="https://cdn.example.com/x.css">',
      '<script src="app.js"></script>',
      '<img src="bg.png" alt="">',
      '<div style="background: url(\'bg.png\')"></div>',
    ].join("\n");
    const file = path.join(dir, "desktop.html");
    const { html: out, files } = await inlineHtml(html, file, path.join(root, "design"));
    expect(out).toContain("--accent: red");
    expect(out).toContain('url("data:image/png;base64,AQID")');
    expect(out).toContain('href="https://cdn.example.com/x.css"');
    expect(out).toContain("console.log('<\\/script>')");
    expect(out).toContain('src="data:image/png;base64,AQID"');
    expect(out).toContain("style=\"background: url(&quot;data:image/png;base64,AQID&quot;)\"");
    expect(files.map((f) => path.basename(f)).sort()).toEqual(["app.js", "bg.png", "style.css", "tokens.css"]);
  });

  test("a stylesheet that does not exist yet is left empty, and the page changes once it appears", async () => {
    await makeDesign("pricing", '<!doctype html><head><link rel="stylesheet" href="tweaks.css"></head><p>Hi</p>');
    const before = (await store.viewDesign(root, "pricing")).artboards[0]!;
    expect(before.html).toContain('<style data-dc-href="tweaks.css"></style>');
    await writeFile(path.join(root, "design", "pricing", "tweaks.css"), ":root { --gap: 4px; }");
    const after = (await store.viewDesign(root, "pricing")).artboards[0]!;
    expect(after.version).not.toBe(before.version);
    expect(after.html).toContain("--gap: 4px");
  });

  test("never reads outside design/, even through a symlink", async () => {
    const dir = path.join(root, "design", "pricing");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(root, "secret.css"), "body { color: secret; }");
    await symlink(path.join(root, "secret.css"), path.join(dir, "link.css"));
    const html = '<link rel="stylesheet" href="../../secret.css"><link rel="stylesheet" href="link.css">';
    const { html: out } = await inlineHtml(html, path.join(dir, "desktop.html"), path.join(root, "design"));
    expect(out).not.toContain("secret;");
  });
});

describe("deleting", () => {
  test("moves the design to design/.trash/, out of the list, and refuses one that is not there", async () => {
    await makeDesign("pricing");
    const { trashedTo } = await store.trashDesign(root, "pricing", Date.UTC(2026, 10, 5, 9, 30, 0));
    expect(trashedTo).toBe("design/.trash/pricing-2026-11-05T09-30-00Z");
    expect(await readFile(path.join(root, trashedTo, "desktop.html"), "utf8")).toContain("Hi");
    expect(await store.listSlugs(root)).toEqual([]);
    await makeDesign("pricing");
    expect((await store.trashDesign(root, "pricing", Date.UTC(2026, 10, 5, 9, 30, 0))).trashedTo).toBe("design/.trash/pricing-2026-11-05T09-30-00Z-2");
    await expect(store.trashDesign(root, "pricing", 0)).rejects.toThrow(/No design pricing/);
  });
});

describe("renaming", () => {
  test("changes the title in design.json and keeps the folder", async () => {
    await makeDesign("pricing");
    await store.renameDesign(root, "pricing", "Pricing v2");
    expect((await store.readManifest(root, "pricing")).manifest?.title).toBe("Pricing v2");
    expect(await store.listSlugs(root)).toEqual(["pricing"]);
  });
});

