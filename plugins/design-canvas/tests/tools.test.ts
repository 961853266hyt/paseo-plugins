import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentToolContext, AgentToolDefinition } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Anchor } from "../shared/design";
import { commentsPrompt } from "../shared/prompts";
import * as store from "../server/store";
import { createDesignTools } from "../server/tools";

let root: string;
let tools: Map<string, AgentToolDefinition>;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "design-tools-"));
  tools = new Map(createDesignTools(() => 42).map((tool) => [tool.name, tool]));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(name: string, input: unknown) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`No tool ${name}`);
  const context = {
    agent: { id: "a1", workspaceId: "w1", parentAgentId: null, provider: "claude", cwd: root, title: null },
    paseo: {},
    signal: new AbortController().signal,
  } as unknown as AgentToolContext;
  return tool.execute(tool.input.parse(input), context);
}

const anchor: Anchor = {
  artboardId: "desktop",
  dcId: "cta",
  path: "body > button:nth-of-type(1)",
  tag: "button",
  text: "Buy now",
  html: "<button>Buy now</button>",
  rect: { x: 0, y: 0, width: 10, height: 10 },
};

describe("design tools", () => {
  test("design_create sets up the workspace, the manifest and placeholder pages", async () => {
    const result = await run("design_create", {
      slug: "pricing",
      title: "Pricing",
      kind: "prototype",
      artboards: [
        { id: "desktop", title: "Desktop", width: 1440, group: "home" },
        { id: "mobile", title: "Mobile", width: 390, height: 844, group: "home" },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(await store.isInitialized(root)).toBe(true);
    const manifest = (await store.readManifest(root, "pricing")).manifest;
    expect(manifest?.artboards.map((artboard) => artboard.file)).toEqual(["desktop.html", "mobile.html"]);
    expect(await readFile(path.join(root, "design", "pricing", "mobile.html"), "utf8")).toContain('data-dc-id="placeholder"');
    const again = await run("design_create", { slug: "pricing", title: "x", kind: "other", artboards: [{ id: "a", title: "A", width: 400 }] });
    expect(again.isError).toBe(true);
  });

  test("design_read lists open comments with their elements; design_resolve_comments resolves by number", async () => {
    await run("design_create", { slug: "pricing", title: "Pricing", kind: "prototype", artboards: [{ id: "desktop", title: "Desktop", width: 1440 }] });
    await store.addComment(root, "pricing", "Make it green", anchor, 1);
    const read = await run("design_read", { slug: "pricing" });
    expect(read.text).toContain('#1 on Desktop (desktop.html)');
    expect(read.text).toContain('[data-dc-id="cta"]');
    expect(read.text).toContain("Make it green");
    const resolved = await run("design_resolve_comments", { slug: "pricing", resolutions: [{ comment: 1, note: "Green now" }] });
    expect(resolved.text).toBe("Resolved #1.");
    expect((await run("design_read", { slug: "pricing" })).text).toContain("No open comments.");
    const missing = await run("design_resolve_comments", { slug: "pricing", resolutions: [{ comment: 7, note: "x" }] });
    expect(missing.isError).toBe(true);
  });

  test("design_list reports each design", async () => {
    expect((await run("design_list", {})).text).toMatch(/No designs/);
    await run("design_create", { slug: "pricing", title: "Pricing", kind: "prototype", artboards: [{ id: "desktop", title: "Desktop", width: 1440 }] });
    expect((await run("design_list", {})).text).toContain('pricing: "Pricing" (prototype), 1 artboards, 0 open comments');
  });
});

describe("prompts", () => {
  test("the comments message names each element and asks for design_resolve_comments", () => {
    const comment = { id: "c-abcd", number: 3, body: "Bigger\nand bolder", anchor, status: "pending" as const, createdAt: 1 };
    const message = commentsPrompt("pricing", null, [comment]);
    expect(message).toContain("design/pricing/");
    expect(message).toContain("#3 on desktop");
    expect(message).toContain("Comment: Bigger\n    and bolder");
    expect(message).toContain("design_resolve_comments");
  });
});
