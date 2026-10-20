import { describe, expect, test } from "vitest";
import {
  buildTranscript,
  clip,
  HISTORY_LEFT_OUT,
  IN_PROGRESS_OUTPUT,
  DETAIL_LEFT_OUT,
  type TimelineItem,
} from "../server/transcript";

function tool(
  callId: string,
  status: "running" | "completed" | "failed" | "canceled",
  detail: Extract<TimelineItem, { type: "tool_call" }>["detail"],
  extra: { name?: string; error?: unknown } = {},
): TimelineItem {
  return {
    type: "tool_call",
    callId,
    name: extra.name ?? "Bash",
    status,
    error: extra.error ?? null,
    detail,
  } as TimelineItem;
}

describe("buildTranscript", () => {
  test("labels messages and thinking, joins streamed text and leaves out plugin rows", () => {
    const transcript = buildTranscript([
      { type: "user_message", text: "fix the login bug" },
      { type: "reasoning", text: "The bug is " },
      { type: "reasoning", text: "probably in auth." },
      { type: "assistant_message", text: "Looking at " },
      { type: "assistant_message", text: "auth.ts now." },
      { type: "plugin", id: "row", pluginId: "other", kind: "card", version: 1, data: null },
    ]);
    expect(transcript).toBe(
      [
        "[User]\nfix the login bug",
        "[Thinking]\nThe bug is probably in auth.",
        "[Assistant]\nLooking at auth.ts now.",
      ].join("\n\n"),
    );
  });

  test("shows each tool call once, in its latest state, with its output", () => {
    const transcript = buildTranscript([
      tool("c1", "running", { type: "read", filePath: "src/auth.ts" }, { name: "Read" }),
      tool("c2", "completed", { type: "shell", command: "npm test", output: "1 failing", exitCode: 1 }),
      tool("c1", "completed", { type: "read", filePath: "src/auth.ts", content: "export {}" }, { name: "Read" }),
    ]);
    expect(transcript).toBe(
      [
        "[Tool: Read] src/auth.ts\n<output>\nexport {}\n</output>",
        "[Tool: Bash] npm test (exit code 1)\n<output>\n1 failing\n</output>",
      ].join("\n\n"),
    );
  });

  test("marks calls still running, failed or canceled", () => {
    const transcript = buildTranscript([
      tool("c1", "running", { type: "shell", command: "npm run build" }),
      tool("c2", "failed", { type: "fetch", url: "https://example.com" }, { name: "WebFetch", error: { message: "timed out" } }),
      tool("c3", "canceled", { type: "shell", command: "rm -rf dist" }),
    ]);
    expect(transcript).toBe(
      [
        `[Tool: Bash] npm run build\n${IN_PROGRESS_OUTPUT}`,
        "[Tool: WebFetch] https://example.com (failed: timed out)",
        "[Tool: Bash] rm -rf dist (canceled)",
      ].join("\n\n"),
    );
  });

  test("describes edits as removed and added lines when there is no diff", () => {
    const transcript = buildTranscript([
      tool("c1", "completed", { type: "edit", filePath: "a.ts", oldString: "let a = 1", newString: "const a = 1" }, { name: "Edit" }),
    ]);
    expect(transcript).toBe("[Tool: Edit] a.ts\n<output>\n- let a = 1\n+ const a = 1\n</output>");
  });

  test("keeps only the latest task list, at its own place", () => {
    const transcript = buildTranscript([
      { type: "todo", items: [{ text: "write tests", completed: false }] },
      { type: "user_message", text: "go on" },
      {
        type: "todo",
        items: [
          { text: "write tests", completed: true },
          { text: "ship it", completed: false },
        ],
      },
    ]);
    expect(transcript).toBe("[User]\ngo on\n\n[Tasks]\n- [x] write tests\n- [ ] ship it");
  });

  test("gives messages priority over tool output and keeps the newest outputs", () => {
    const items: TimelineItem[] = [
      { type: "user_message", text: "check both files" },
      tool("c1", "completed", { type: "read", filePath: "old.ts", content: "o".repeat(400) }, { name: "Read" }),
      tool("c2", "completed", { type: "read", filePath: "new.ts", content: "n".repeat(400) }, { name: "Read" }),
      { type: "assistant_message", text: "Both read." },
    ];
    const transcript = buildTranscript(items, { budgetChars: 700 });
    expect(transcript.startsWith(`${DETAIL_LEFT_OUT}\n\n[User]\ncheck both files`)).toBe(true);
    expect(transcript).toContain("[Tool: Read] old.ts\n\n[Tool: Read] new.ts\n<output>\nnnnn");
    expect(transcript).not.toContain("oooo");
    expect(transcript.endsWith("[Assistant]\nBoth read.")).toBe(true);
  });

  test("drops older thinking before newer tool output, without leaving an empty entry", () => {
    const transcript = buildTranscript(
      [
        { type: "reasoning", text: "t".repeat(400) },
        { type: "user_message", text: "go" },
        tool("c1", "completed", { type: "shell", command: "ls", output: "a.ts" }),
      ],
      { budgetChars: 200 },
    );
    expect(transcript).toBe(`${DETAIL_LEFT_OUT}\n\n[User]\ngo\n\n[Tool: Bash] ls\n<output>\na.ts\n</output>`);
  });

  test("keeps the first user message and the newest history when the messages overflow", () => {
    const items: TimelineItem[] = [
      { type: "user_message", text: "the task" },
      ...Array.from({ length: 10 }, (_, index): TimelineItem => ({
        type: "assistant_message",
        text: `${index} ${"x".repeat(80)}`,
      })).flatMap((message, index): TimelineItem[] => [message, { type: "user_message", text: `next ${index}` }]),
    ];
    const transcript = buildTranscript(items, { budgetChars: 300 });
    expect(transcript.startsWith(`[User]\nthe task\n\n${HISTORY_LEFT_OUT}\n\n`)).toBe(true);
    expect(transcript.endsWith("[User]\nnext 9")).toBe(true);
    expect(transcript).not.toContain("[Assistant]\n0 ");
  });

  test("opens a partly fetched timeline with the session's first request", () => {
    const transcript = buildTranscript([{ type: "user_message", text: "latest" }], {
      olderHistory: { firstUserMessage: "the original task" },
    });
    expect(transcript).toBe(`[User]\nthe original task\n\n${HISTORY_LEFT_OUT}\n\n[User]\nlatest`);
  });

  test("returns an empty transcript for an empty conversation", () => {
    expect(buildTranscript([])).toBe("");
  });
});

describe("clip", () => {
  test("keeps the start and the end of long text and says how much is left out", () => {
    const text = `${"a".repeat(500)}${"b".repeat(500)}`;
    const clipped = clip(text, 200);
    expect(clipped.startsWith("aaaa")).toBe(true);
    expect(clipped.endsWith("bbbb")).toBe(true);
    const marker = /\n\[… (\d+) characters left out …\]\n/.exec(clipped)!;
    expect(Number(marker[1])).toBe(text.length - (clipped.length - marker[0].length));
    expect(clipped.length).toBeLessThanOrEqual(201);
  });

  test("leaves short text alone", () => {
    expect(clip("short", 200)).toBe("short");
  });
});
