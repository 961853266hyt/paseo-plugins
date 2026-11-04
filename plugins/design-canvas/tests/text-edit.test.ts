// @vitest-environment happy-dom
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { TextTarget } from "../shared/design";
import { decodeText, findText, replaceText } from "../server/html-patch";
import * as store from "../server/store";

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Plans &amp; pricing</title>
<style>.a > b { color: red } /* <p>not a tag</p> */</style>
</head>
<body>
  <!-- a comment <div> -->
  <header data-dc-id="top"><img src="logo.png" alt="">Slow&nbsp;Tides <b>Records</b>, est. 2019</header>
  <main>
    <h1 data-dc-id="title">Plans &amp; pricing</h1>
    <ul>
      <li>One
      <li>Two &mdash; <em>best</em> value
      <li>Three</li>
    </ul>
    <p class="note">Fair &#8220;use&#8221; &#x2014; caf&eacute; <span title="a > b">x</span> tail</p>
    <svg viewBox="0 0 10 10"><path d="M0 0h10"/><text>chart</text></svg>
    <script>var markup = "<p>not a tag</p>";</script>
    <p>Line one<br>line two</p>
  </main>
</body>
</html>
`;

/** What the canvas runtime sends for a text node: the same walk, written against the DOM. */
function locate(node: Text): TextTarget | null {
  const el = node.parentElement!;
  let index = 0;
  for (let c = el.firstChild; c && c !== node; c = c.nextSibling) if (c.nodeType === 3) index++;
  const steps: number[] = [];
  let cur: Element = el;
  while (cur !== document.body) {
    const id = cur.getAttribute("data-dc-id");
    if (id && document.querySelectorAll(`[data-dc-id="${id}"]`).length === 1) return { dcId: id, path: steps, index };
    const parent = cur.parentElement;
    if (!parent) return null;
    steps.unshift(Array.prototype.indexOf.call(parent.children, cur));
    cur = parent;
  }
  return { path: steps, index };
}

function textNodes(): Text[] {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement!;
    if (/\S/.test((node as Text).data) && !parent.closest("script, style, svg")) out.push(node as Text);
  }
  return out;
}

describe("finding text in the source", () => {
  test("every text node the browser builds maps back to the same text in the source", () => {
    document.open();
    document.write(PAGE);
    document.close();
    const nodes = textNodes();
    expect(nodes.length).toBeGreaterThan(8);
    for (const node of nodes) {
      const target = locate(node);
      expect(target, node.data).not.toBeNull();
      const run = findText(PAGE, target!);
      const source = PAGE.slice(run.start, run.end);
      expect(() => replaceText(PAGE, target!, node.data, node.data), `${JSON.stringify(target)} ${source}`).not.toThrow();
    }
  });

  test("decodes named, decimal and hex entities and remembers where they were", () => {
    const { text, offsets, unknown } = decodeText("a&amp;b&#8220;&#x2014;&nbsp;\r\nc&eacute; & d");
    expect(text).toBe("a&b\u201c\u2014\u00a0\nc\ufffd & d");
    expect(offsets[1]).toBe(1);
    expect(offsets[2]).toBe(6);
    expect(unknown).toEqual([8]);
  });
});

describe("replacing text", () => {
  const target = { dcId: "title", path: [], index: 0 };

  test("rewrites only the changed middle, so entities around it stay", () => {
    const out = replaceText(PAGE, target, "Plans & pricing", "Plans & prices");
    expect(out).toContain('<h1 data-dc-id="title">Plans &amp; prices</h1>');
    expect(out.replace("Plans &amp; prices", "Plans &amp; pricing")).toBe(PAGE);
  });

  test("escapes what the user typed", () => {
    expect(replaceText(PAGE, target, "Plans & pricing", "<b>Tom & Jerry</b>")).toContain(
      '<h1 data-dc-id="title">&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;</h1>',
    );
  });

  test("an edit inside an entity's text replaces the whole entity", () => {
    const header = { dcId: "top", path: [], index: 0 };
    const before = "Slow Tides ";
    expect(replaceText(PAGE, header, before, "Slow Tides ")).toContain('alt="">Slow Tides <b>');
  });

  test("an entity it doesn't know matches the character the browser shows", () => {
    const note = { path: [1, 2], index: 0 };
    const out = replaceText(PAGE, note, "Fair “use” — café ", "Fair use — café ");
    expect(out).toContain("<p class=\"note\">Fair use &#x2014; caf&eacute; <span");
  });

  test("refuses when the source no longer has the text the canvas showed", () => {
    expect(() => replaceText(PAGE, target, "Plans and pricing", "x")).toThrow(/not the text on the canvas/);
    expect(() => replaceText(PAGE, { path: [9, 9], index: 0 }, "a", "b")).toThrow(/not in the page's source/);
    expect(() => replaceText(PAGE, { dcId: "nope", path: [], index: 0 }, "a", "b")).toThrow(/No element/);
  });
});

describe("editing text in a design", () => {
  let root: string;
  const file = () => path.join(root, "design", "pricing", "desktop.html");
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "design-text-"));
    await mkdir(path.dirname(file()), { recursive: true });
    await writeFile(
      path.join(root, "design", "pricing", "design.json"),
      JSON.stringify({ version: 1, title: "P", kind: "prototype", artboards: [{ id: "desktop", title: "D", file: "desktop.html", width: 800 }] }),
    );
    await writeFile(file(), PAGE);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("writes the text, returns the new hash, then refuses a stale one", async () => {
    const before = (await store.viewDesign(root, "pricing")).artboards[0]!.source;
    const result = await store.editText(root, "pricing", "desktop", { dcId: "title", path: [], index: 0 }, "Plans & pricing", "Pricing", before);
    expect(await readFile(file(), "utf8")).toContain('<h1 data-dc-id="title">Pricing</h1>');
    expect(result.source).toBe((await store.viewDesign(root, "pricing")).artboards[0]!.source);
    await expect(
      store.editText(root, "pricing", "desktop", { dcId: "title", path: [], index: 0 }, "Pricing", "x", before),
    ).rejects.toThrow(store.ConflictError);
  });
});
