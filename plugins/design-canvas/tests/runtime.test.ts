import { describe, expect, test } from "vitest";
import { buildSrcdoc, DESIGN_CSP, RUNTIME_SOURCE } from "../client/runtime";
import { fromRuntimeSchema, PROTOCOL_MARK } from "../shared/runtime-protocol";

describe("runtime", () => {
  test("is valid JavaScript with no bundler helpers", () => {
    expect(() => new Function(RUNTIME_SOURCE)).not.toThrow();
    expect(RUNTIME_SOURCE).not.toMatch(/__name|__require|import\s/);
    expect(RUNTIME_SOURCE).toContain(JSON.stringify(PROTOCOL_MARK));
  });

  test("goes first in the head, after the CSP", () => {
    const doc = buildSrcdoc('<!doctype html><html lang="en"><head><title>x</title></head><body></body></html>');
    const csp = doc.indexOf("Content-Security-Policy");
    expect(csp).toBeGreaterThan(doc.indexOf("<head>"));
    expect(doc.indexOf("<script>")).toBeGreaterThan(csp);
    expect(doc.indexOf("<script>")).toBeLessThan(doc.indexOf("<title>"));
  });

  test("adds a head when the page has none", () => {
    expect(buildSrcdoc("<!doctype html><p>hi</p>")).toMatch(/^<!doctype html><head><meta http-equiv="Content-Security-Policy"/);
    expect(buildSrcdoc("<html><p>hi</p></html>")).toMatch(/^<html><head><meta/);
    expect(buildSrcdoc("<p>hi</p>")).toMatch(/^<head><meta/);
  });

  test("the CSP blocks network requests", () => {
    expect(DESIGN_CSP).toContain("default-src 'none'");
    expect(DESIGN_CSP).toContain("connect-src 'none'");
    expect(DESIGN_CSP).not.toMatch(/https?:/);
  });

  test("the canvas accepts only marked, well-formed messages", () => {
    expect(fromRuntimeSchema.safeParse({ mark: PROTOCOL_MARK, type: "size", height: 10 }).success).toBe(true);
    expect(fromRuntimeSchema.safeParse({ type: "size", height: 10 }).success).toBe(false);
    expect(fromRuntimeSchema.safeParse({ mark: PROTOCOL_MARK, type: "pick", picked: { path: "body" } }).success).toBe(false);
    expect(fromRuntimeSchema.safeParse({ mark: PROTOCOL_MARK, type: "send", text: "rm -rf" }).success).toBe(false);
  });
});

describe("plugin icon", () => {
  test("the inline mark passes Paseo's SVG rules", async () => {
    const { findSvgIconProblem, PLUGIN_SVG_ICON_MAX_BYTES } = await import("@getpaseo/plugin");
    const { PLUGIN_ICON_SVG } = await import("../client/icons");
    expect(findSvgIconProblem(PLUGIN_ICON_SVG)).toBeNull();
    expect(PLUGIN_ICON_SVG.length).toBeLessThan(PLUGIN_SVG_ICON_MAX_BYTES);
  });
});
