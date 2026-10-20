import { describe, expect, test } from "vitest";
import { parseInline, parseMarkdown } from "../client/markdown";

describe("parseMarkdown", () => {
  test("splits paragraphs, headings, rules and quotes", () => {
    expect(parseMarkdown("# Title\n\nFirst line\nsecond line\n\n---\n> quoted\n> more")).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "paragraph", lines: ["First line", "second line"] },
      { kind: "rule" },
      { kind: "quote", lines: ["quoted", "more"] },
    ]);
  });

  test("keeps code fences verbatim, closed or still streaming", () => {
    expect(parseMarkdown("```ts\nconst a = 1;\n  indented\n```\nafter")).toEqual([
      { kind: "code", text: "const a = 1;\n  indented" },
      { kind: "paragraph", lines: ["after"] },
    ]);
    expect(parseMarkdown("Look:\n```\npartial")).toEqual([
      { kind: "paragraph", lines: ["Look:"] },
      { kind: "code", text: "partial" },
    ]);
  });

  test("reads bullet and numbered lists with nesting and continuation lines", () => {
    expect(parseMarkdown("- one\n  - nested\n- two\n  continued\n\n1. first\n2) second")).toEqual([
      {
        kind: "list",
        items: [
          { depth: 0, marker: "•", lines: ["one"] },
          { depth: 1, marker: "•", lines: ["nested"] },
          { depth: 0, marker: "•", lines: ["two", "continued"] },
        ],
      },
      {
        kind: "list",
        items: [
          { depth: 0, marker: "1.", lines: ["first"] },
          { depth: 0, marker: "2.", lines: ["second"] },
        ],
      },
    ]);
  });

  test("closes a fence only on a run of its own character at least as long", () => {
    expect(parseMarkdown("````md\n```js\nx\n```\n````\nafter")).toEqual([
      { kind: "code", text: "```js\nx\n```" },
      { kind: "paragraph", lines: ["after"] },
    ]);
  });

  test("drops a heading's closing #s but keeps a # that is part of a word", () => {
    expect(parseMarkdown("## Results ##\n### C#")).toEqual([
      { kind: "heading", level: 2, text: "Results" },
      { kind: "heading", level: 3, text: "C#" },
    ]);
  });

  test("parses a heading with a long run of spaces without stalling", () => {
    const started = Date.now();
    const blocks = parseMarkdown(`## Results${" ".repeat(20_000)}done`);
    expect(Date.now() - started).toBeLessThan(200);
    expect(blocks).toEqual([{ kind: "heading", level: 2, text: `Results${" ".repeat(20_000)}done` }]);
  });

  test("keeps tables as rows of text", () => {
    expect(parseMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")).toEqual([
      { kind: "table", lines: ["| a | b |", "|---|---|", "| 1 | 2 |"] },
    ]);
  });
});

describe("parseInline", () => {
  test("reads code, bold, italic and links", () => {
    expect(parseInline("Run `npm test` **now**, *please*, see [docs](https://example.com).")).toEqual([
      { text: "Run " },
      { text: "npm test", code: true },
      { text: " " },
      { text: "now", bold: true },
      { text: ", " },
      { text: "please", italic: true },
      { text: ", see " },
      { text: "docs", url: "https://example.com" },
      { text: "." },
    ]);
  });

  test("leaves snake_case names and lone asterisks alone", () => {
    expect(parseInline("set max_retry_count to 2 * 3")).toEqual([{ text: "set max_retry_count to 2 * 3" }]);
  });

  test("does not read double underscores inside a word as emphasis", () => {
    expect(parseInline("call foo__bar__baz()")).toEqual([{ text: "call foo__bar__baz()" }]);
  });

  test("does not read emphasis inside code", () => {
    expect(parseInline("`**not bold**`")).toEqual([{ text: "**not bold**", code: true }]);
  });

  test("drops links that are not http or https", () => {
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ text: "x" }, { text: ")" }]);
  });

  test("nests emphasis inside links and bold", () => {
    expect(parseInline("**see `a.ts`**")).toEqual([
      { text: "see ", bold: true },
      { text: "a.ts", bold: true, code: true },
    ]);
  });
});
