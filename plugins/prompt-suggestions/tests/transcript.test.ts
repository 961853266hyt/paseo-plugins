import { describe, expect, test } from "vitest";
import { buildTranscript, countUserMessages, type TimelineItem } from "../server/transcript";

const conversation: TimelineItem[] = [
  { type: "user_message", text: "fix the login bug" },
  { type: "reasoning", text: "thinking about it" },
  { type: "assistant_message", text: "Found it. " },
  { type: "assistant_message", text: "Want me to run the tests?" },
  {
    type: "tool_call",
    callId: "call-1",
    name: "Bash",
    status: "completed",
    error: null,
    detail: { type: "unknown", input: null, output: null },
  } as TimelineItem,
  { type: "error", message: "network hiccup" },
];

describe("buildTranscript", () => {
  test("joins assistant chunks, summarizes tools and skips reasoning", () => {
    expect(buildTranscript(conversation)).toBe(
      [
        "User: fix the login bug",
        "Assistant: Found it. Want me to run the tests?",
        "Tool: Bash (completed)",
        "Error: network hiccup",
      ].join("\n"),
    );
  });

  test("keeps the newest lines within the budget", () => {
    const transcript = buildTranscript(conversation, 60);
    expect(transcript).toBe(["Tool: Bash (completed)", "Error: network hiccup"].join("\n"));
  });

  test("always keeps the newest line, clipped to keep its end", () => {
    const long: TimelineItem[] = [
      { type: "assistant_message", text: `${"a".repeat(2000)} Shall I deploy?` },
    ];
    const transcript = buildTranscript(long, 10);
    expect(transcript.startsWith("Assistant: aaa")).toBe(true);
    expect(transcript.endsWith("Shall I deploy?")).toBe(true);
    expect(transcript).toContain(" … ");
    expect(transcript.length).toBeLessThanOrEqual("Assistant: ".length + 1500);
  });
});

test("countUserMessages counts only user messages", () => {
  expect(countUserMessages(conversation)).toBe(1);
});
