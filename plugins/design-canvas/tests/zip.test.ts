import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as store from "../server/store";
import { readZip, writeZip } from "../server/zip";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "design-zip-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("zip", () => {
  test("reads back what it writes, compressed or stored, with UTF-8 names", () => {
    const entries = [
      { name: "a/page.html", data: Buffer.from("<p>hi</p>".repeat(200)), mtime: Date.now() },
      { name: "a/图.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), mtime: Date.now() },
      { name: "a/empty.txt", data: Buffer.alloc(0), mtime: Date.now() },
    ];
    const zip = writeZip(entries);
    expect(zip.length).toBeLessThan(entries[0]!.data.length);
    expect(readZip(zip).map((entry) => [entry.name, entry.data.toString("hex")])).toEqual(
      entries.map((entry) => [entry.name, entry.data.toString("hex")]),
    );
  });

  test("exports a design laid out as under design/, with the shared files its pages use", async () => {
    const dir = path.join(root, "design", "pricing");
    await mkdir(path.join(dir, "img"), { recursive: true });
    await mkdir(path.join(root, "design", "systems"), { recursive: true });
    await mkdir(path.join(root, "design", "other"), { recursive: true });
    await writeFile(
      path.join(dir, "design.json"),
      JSON.stringify({ version: 1, title: "Pricing", kind: "prototype", artboards: [{ id: "desktop", title: "Desktop", file: "desktop.html", width: 1440 }] }),
    );
    await writeFile(path.join(dir, "desktop.html"), '<link rel="stylesheet" href="../systems/brand.css"><img src="img/logo.png">');
    await writeFile(path.join(dir, "img", "logo.png"), "png");
    await writeFile(path.join(dir, "comments.json"), JSON.stringify({ version: 1, nextNumber: 1, comments: [] }));
    await writeFile(path.join(root, "design", "systems", "brand.css"), "body{}");
    await writeFile(path.join(root, "design", "other", "x.html"), "not used");
    const { fileName, zip } = await store.exportDesign(root, "pricing");
    expect(fileName).toBe("pricing.zip");
    const names = readZip(zip).map((entry) => entry.name);
    expect(names[0]).toBe("pricing/design.json");
    expect([...names].sort()).toEqual(["pricing/comments.json", "pricing/design.json", "pricing/desktop.html", "pricing/img/logo.png", "systems/brand.css"]);
  });

  async function sourceDesign(base: string, slug = "pricing") {
    const dir = path.join(base, "design", slug);
    await mkdir(dir, { recursive: true });
    await mkdir(path.join(base, "design", "systems"), { recursive: true });
    await writeFile(
      path.join(dir, "design.json"),
      JSON.stringify({ version: 1, title: "Pricing", kind: "prototype", artboards: [{ id: "desktop", title: "Desktop", file: "desktop.html", width: 1440 }] }),
    );
    await writeFile(path.join(dir, "desktop.html"), '<link rel="stylesheet" href="../systems/brand.css"><p>Hi</p>');
    await writeFile(path.join(base, "design", "systems", "brand.css"), "body{color:red}");
    return (await store.exportDesign(base, slug)).zip;
  }

  test("imports an export under a free name, adds missing shared files and keeps differing ones", async () => {
    const zip = await sourceDesign(path.join(root, "a"));
    const target = path.join(root, "b");
    await mkdir(target, { recursive: true });
    const first = await store.importDesign(target, zip);
    expect(first).toEqual({ slug: "pricing", title: "Pricing", kept: [] });
    expect(await store.isInitialized(target)).toBe(true);
    expect(await store.listSlugs(target)).toEqual(["pricing"]);
    expect(await readFile(path.join(target, "design", "systems", "brand.css"), "utf8")).toBe("body{color:red}");

    await writeFile(path.join(target, "design", "systems", "brand.css"), "body{color:blue}");
    const second = await store.importDesign(target, zip);
    expect(second).toEqual({ slug: "pricing-2", title: "Pricing", kept: ["systems/brand.css"] });
    expect(await readFile(path.join(target, "design", "systems", "brand.css"), "utf8")).toBe("body{color:blue}");
    expect((await store.viewDesign(target, "pricing-2")).artboards[0]?.html).toContain("<p>Hi</p>");
  });

  test("accepts a design folder zipped inside a wrapper folder", async () => {
    const manifest = JSON.stringify({ version: 1, title: "Hello World", kind: "other", artboards: [{ id: "a", title: "A", file: "a.html", width: 400 }] });
    const zip = writeZip([
      { name: "design/Hello World!/design.json", data: Buffer.from(manifest), mtime: 0 },
      { name: "design/Hello World!/a.html", data: Buffer.from("<p>a</p>"), mtime: 0 },
      { name: "__MACOSX/design/._a.html", data: Buffer.from("x"), mtime: 0 },
    ]);
    expect((await store.importDesign(root, zip)).slug).toBe("hello-world");
  });

  test("refuses zips that escape their folder, hold no design, or several", async () => {
    const manifest = Buffer.from(JSON.stringify({ version: 1, title: "X", kind: "other", artboards: [{ id: "a", title: "A", file: "a.html", width: 400 }] }));
    await expect(store.importDesign(root, writeZip([{ name: "x/design.json", data: manifest, mtime: 0 }, { name: "x/../../evil.txt", data: Buffer.from("!"), mtime: 0 }]))).rejects.toThrow(/outside/);
    await expect(store.importDesign(root, writeZip([{ name: "x/a.html", data: Buffer.from("a"), mtime: 0 }]))).rejects.toThrow(/no design/);
    await expect(store.importDesign(root, writeZip([{ name: "x/design.json", data: manifest, mtime: 0 }, { name: "y/design.json", data: manifest, mtime: 0 }]))).rejects.toThrow(/more than one/);
    await expect(store.importDesign(root, writeZip([{ name: "x/design.json", data: Buffer.from("{}"), mtime: 0 }]))).rejects.toThrow(/design.json/);
  });

  test("does not write a shared file through a link that leaves design/", async () => {
    const zip = await sourceDesign(path.join(root, "a"));
    const target = path.join(root, "b");
    const outside = path.join(root, "outside");
    await mkdir(path.join(target, "design"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(target, "design", "systems"));
    await expect(store.importDesign(target, zip)).rejects.toThrow(/outside design/);
    await expect(readFile(path.join(outside, "brand.css"))).rejects.toThrow();
    expect(await store.listSlugs(target)).toEqual([]);
  });
});
