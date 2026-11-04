import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { findByDcId, scanStartTags, setInlineStyle, splitDeclarations } from "../server/html-patch";
import * as store from "../server/store";

function move(html: string, dcId: string, properties: Record<string, string>): string {
  const [tag] = findByDcId(html, dcId);
  if (!tag) throw new Error(`no ${dcId}`);
  return setInlineStyle(html, tag, properties);
}

describe("scanning start tags", () => {
  test("ignores tags inside comments, scripts and styles, and handles > inside quoted values", () => {
    const html = `<!-- <div data-dc-id="a"> -->
<script>const s = '<div data-dc-id="a">';</script>
<style>.x > .y { content: "<p>"; }</style>
<div title="1 > 0" data-dc-id="a" class=card>hi</div>`;
    const tags = findByDcId(html, "a");
    expect(tags).toHaveLength(1);
    expect(html.slice(tags[0]!.start, tags[0]!.end)).toBe('<div title="1 > 0" data-dc-id="a" class=card>');
  });

  test("reads unquoted, single-quoted and boolean attributes", () => {
    const [tag] = scanStartTags("<input disabled value='a b' data-dc-id=x>");
    expect(tag?.attributes.map((attr) => [attr.name, attr.value, attr.quote])).toEqual([
      ["disabled", "", ""],
      ["value", "a b", "'"],
      ["data-dc-id", "x", ""],
    ]);
  });

  test("splits declarations but not inside url() or quotes", () => {
    expect(splitDeclarations(`color: red; background: url("a;b.png"); content: ';'`)).toEqual([
      "color: red",
      'background: url("a;b.png")',
      "content: ';'",
    ]);
  });
});

describe("rewriting one element's style", () => {
  test("adds a style attribute and leaves the rest of the file untouched", () => {
    const html = '<main>\n  <button data-dc-id="cta" class="big">Buy</button>\n</main>\n';
    expect(move(html, "cta", { translate: "12px -8px" })).toBe(
      '<main>\n  <button data-dc-id="cta" class="big" style="translate: 12px -8px">Buy</button>\n</main>\n',
    );
  });

  test("replaces an existing property and keeps the others in place", () => {
    const html = `<div data-dc-id="card" style='color: red; translate: 1px 1px; padding: 4px'></div>`;
    expect(move(html, "card", { translate: "20px 0px" })).toBe(`<div data-dc-id="card" style='color: red; padding: 4px; translate: 20px 0px'></div>`);
  });

  test("an empty value removes the property, and the attribute when nothing is left", () => {
    const html = '<div data-dc-id="card" style="translate: 3px 4px">x</div>';
    expect(move(html, "card", { translate: "" })).toBe('<div data-dc-id="card">x</div>');
  });

  test("self-closing tags keep their slash", () => {
    expect(move('<img data-dc-id="logo" src="a.png"/>', "logo", { left: "10px", top: "4px" })).toBe(
      '<img data-dc-id="logo" src="a.png" style="left: 10px; top: 4px"/>',
    );
  });
});

describe("moving in a design", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "design-move-"));
    const dir = path.join(root, "design", "pricing");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "design.json"),
      JSON.stringify({ version: 1, title: "P", kind: "prototype", artboards: [{ id: "desktop", title: "D", file: "desktop.html", width: 800 }] }),
    );
    await writeFile(path.join(dir, "desktop.html"), '<p data-dc-id="a">A</p><p data-dc-id="dup">1</p><p data-dc-id="dup">2</p>');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const source = async () => (await store.viewDesign(root, "pricing")).artboards[0]!.source;

  test("writes the move and returns the new hash, then refuses a stale one", async () => {
    const before = await source();
    const result = await store.moveElement(root, "pricing", "desktop", "a", { translate: "5px 6px" }, before);
    expect(await readFile(path.join(root, "design", "pricing", "desktop.html"), "utf8")).toContain('style="translate: 5px 6px"');
    expect(result.source).toBe(await source());
    await expect(store.moveElement(root, "pricing", "desktop", "a", { translate: "0px 0px" }, before)).rejects.toThrow(store.ConflictError);
  });

  test("refuses ids that are missing or shared", async () => {
    const current = await source();
    await expect(store.moveElement(root, "pricing", "desktop", "nope", { translate: "1px 1px" }, current)).rejects.toThrow(/No element/);
    await expect(store.moveElement(root, "pricing", "desktop", "dup", { translate: "1px 1px" }, current)).rejects.toThrow(/2 elements share/);
  });

  test("pins an artboard and returns it to the automatic layout", async () => {
    await store.moveArtboard(root, "pricing", "desktop", { x: 120.4, y: -30 });
    expect((await store.readManifest(root, "pricing")).manifest?.artboards[0]).toMatchObject({ x: 120, y: -30 });
    await store.moveArtboard(root, "pricing", "desktop", null);
    expect((await store.readManifest(root, "pricing")).manifest?.artboards[0]).not.toHaveProperty("x");
  });
});
