import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentToolContext } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { manifestSchema } from "../shared/design";
import { applyTweaksPrompt, tweaksPrompt } from "../shared/prompts";
import { checkValue, overrides, renderTweaksCss, type Tweak, tweaksListSchema, usesVariable } from "../shared/tweaks";
import * as store from "../server/store";
import { createDesignTools } from "../server/tools";

const TWEAKS: Tweak[] = [
  { id: "accent", label: "Accent", type: "color", var: "--accent", default: "#d97757" },
  { id: "gap", label: "Gap", type: "range", var: "--gap", min: 8, max: 48, step: 4, unit: "px", default: 24 },
  { id: "badge", label: "Badge", type: "toggle", var: "--badge", on: "inline-flex", off: "none", default: true },
  {
    id: "hero",
    label: "Hero",
    type: "select",
    var: "--hero",
    options: [
      { label: "Left", value: "start" },
      { label: "Center", value: "center" },
    ],
    default: "start",
  },
];

describe("tweak declarations", () => {
  test("accept the four kinds and refuse broken ones", () => {
    expect(tweaksListSchema.safeParse(TWEAKS).success).toBe(true);
    const bad = (tweak: unknown) => tweaksListSchema.safeParse([tweak]).success;
    expect(bad({ ...TWEAKS[1], default: 60 })).toBe(false);
    expect(bad({ ...TWEAKS[3], default: "end" })).toBe(false);
    expect(bad({ ...TWEAKS[0], var: "accent" })).toBe(false);
    expect(bad({ ...TWEAKS[0], default: "red; } body { display: none" })).toBe(false);
    expect(tweaksListSchema.safeParse([TWEAKS[0], { ...TWEAKS[1], var: "--accent" }]).success).toBe(false);
  });

  test("values are checked, clamped and snapped", () => {
    expect(checkValue(TWEAKS[1]!, 23)).toBe(24);
    expect(checkValue(TWEAKS[1]!, 99)).toBe(48);
    expect(checkValue(TWEAKS[1]!, "24")).toBeNull();
    expect(checkValue(TWEAKS[2]!, "yes")).toBeNull();
    expect(checkValue(TWEAKS[3]!, "end")).toBeNull();
    expect(checkValue(TWEAKS[0]!, "rgb(1 2 3)")).toBe("rgb(1 2 3)");
  });

  test("only values away from the default reach the page and tweaks.css", () => {
    const values = { accent: "#000", gap: 24, badge: false, hero: "center" };
    expect(overrides(TWEAKS, values)).toEqual({ "--accent": "#000", "--gap": "", "--badge": "none", "--hero": "center" });
    expect(renderTweaksCss(TWEAKS, values)).toContain(":root {\n  --accent: #000;\n  --badge: none;\n  --hero: center;\n}");
    expect(renderTweaksCss(TWEAKS, {})).not.toContain(":root");
  });

  test("a page uses a variable only through var()", () => {
    expect(usesVariable(".a { gap: var(--gap); }", "--gap")).toBe(true);
    expect(usesVariable(".a { color: var( --accent , red) }", "--accent")).toBe(true);
    expect(usesVariable(":root { --gap: 4px; } .a { gap: var(--gap-wide) }", "--gap")).toBe(false);
  });

  test("the manifest carries them", () => {
    const manifest = { version: 1, title: "P", kind: "prototype", artboards: [{ id: "a", title: "A", file: "a.html", width: 400 }], tweaks: TWEAKS };
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
  });
});

describe("tweaks in a design", () => {
  let root: string;
  const dir = () => path.join(root, "design", "pricing");
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "design-tweaks-"));
    await mkdir(dir(), { recursive: true });
    await writeFile(
      path.join(dir(), "design.json"),
      JSON.stringify({ version: 1, title: "P", kind: "prototype", artboards: [{ id: "desktop", title: "D", file: "desktop.html", width: 800 }], tweaks: TWEAKS }),
    );
    await writeFile(
      path.join(dir(), "desktop.html"),
      '<!doctype html><head><style>:root{--accent:#d97757;--gap:24px}</style><link rel="stylesheet" href="tweaks.css"></head><body style="gap:var(--gap);color:var(--accent)">Hi</body>',
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("saving writes tweaks.json and tweaks.css, and the page that links it gets a new version", async () => {
    const before = (await store.viewDesign(root, "pricing")).artboards[0]!.version;
    const saved = await store.saveTweaks(root, "pricing", { gap: 32, accent: "#d97757", nope: 1 });
    expect(saved.values).toEqual({ gap: 32 });
    expect(saved.versions.desktop).not.toBe(before);
    expect(await readFile(path.join(dir(), "tweaks.css"), "utf8")).toContain("--gap: 32px;");
    const view = await store.viewDesign(root, "pricing");
    expect(view.tweakValues).toEqual({ gap: 32 });
    expect(view.artboards[0]!.version).toBe(saved.versions.desktop);
    expect(view.artboards[0]!.html).toContain("--gap: 32px;");
  });

  test("values the agent folds into the defaults stop being overrides", async () => {
    await store.saveTweaks(root, "pricing", { gap: 32, hero: "center" });
    await store.setTweaks(root, "pricing", TWEAKS.map((tweak): Tweak => (tweak.type === "range" ? { ...tweak, default: 32 } : tweak)));
    expect((await store.viewDesign(root, "pricing")).tweakValues).toEqual({ hero: "center" });
    expect(await readFile(path.join(dir(), "tweaks.css"), "utf8")).not.toContain("--gap");
  });

  test("design_set_tweaks replaces the list, keeps fitting values and names unused variables", async () => {
    await store.saveTweaks(root, "pricing", { gap: 32, accent: "#000000" });
    const tool = createDesignTools().find((candidate) => candidate.name === "design_set_tweaks")!;
    const context = { agent: { cwd: root }, paseo: {}, signal: new AbortController().signal } as unknown as AgentToolContext;
    const result = await tool.execute(tool.input.parse({ slug: "pricing", tweaks: [TWEAKS[1], TWEAKS[3]] }), context);
    expect(result.text).toContain("No page reads --hero");
    expect((await store.viewDesign(root, "pricing")).tweakValues).toEqual({ gap: 32 });
    const read = createDesignTools().find((candidate) => candidate.name === "design_read")!;
    expect((await read.execute(read.input.parse({ slug: "pricing" }), context)).text).toContain("--gap = 32px (default 24px)");
  });

  test("the ask names the design and the conventions", () => {
    const prompt = tweaksPrompt("pricing", { version: 1, title: "P", kind: "prototype", artboards: [{ id: "a", title: "A", file: "a.html", width: 400 }], tweaks: [TWEAKS[0]!] });
    expect(prompt).toContain("design/pricing/");
    expect(prompt).toContain("design_set_tweaks");
    expect(prompt).toContain("already has accent");
    const apply = applyTweaksPrompt("pricing", { version: 1, title: "P", kind: "prototype", artboards: [{ id: "a", title: "A", file: "a.html", width: 400 }], tweaks: TWEAKS }, { gap: 32 });
    expect(apply).toContain("--gap = 32px (now 24px)");
    expect(apply).not.toContain("--accent");
  });
});

describe("the guide", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "design-guide-"));
    await mkdir(path.join(root, "design"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("an older copy is brought up to date, a README of the user's is left alone", async () => {
    const readme = path.join(root, "design", "README.md");
    await writeFile(readme, "# Designs\n\nThis folder holds designs shown on the Design canvas in Paseo. Old text.\n");
    await store.refreshGuide(root);
    expect(await readFile(readme, "utf8")).toContain("## Tweaks");
    await writeFile(readme, "# Our design notes\n");
    await store.refreshGuide(root);
    expect(await readFile(readme, "utf8")).toBe("# Our design notes\n");
  });
});
