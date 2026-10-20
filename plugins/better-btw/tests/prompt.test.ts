import { describe, expect, test } from "vitest";
import { buildPrompt, CUT_OFF_NOTE, writesToolCalls } from "../server/prompt";

describe("buildPrompt", () => {
  test("puts the conversation first and the side question last", () => {
    const prompt = buildPrompt({
      transcript: "[User]\nfix it",
      agentRunning: false,
      earlier: [],
      question: "which file?",
    });
    expect(prompt.startsWith("<conversation>\n[User]\nfix it\n</conversation>")).toBe(true);
    expect(prompt.endsWith("<side_question>\nwhich file?\n</side_question>")).toBe(true);
    expect(prompt).not.toContain("still working");
    expect(prompt).not.toContain("<earlier_side_questions>");
  });

  test("warns that a running agent's last entries may be incomplete", () => {
    const prompt = buildPrompt({ transcript: "t", agentRunning: true, earlier: [], question: "q" });
    expect(prompt).toContain("You are still working");
  });

  test("replays earlier side questions, swapping answers that would mislead for a note", () => {
    const prompt = buildPrompt({
      transcript: "t",
      agentRunning: false,
      earlier: [
        { question: "first?", answer: "First answer." },
        { question: "tools?", answer: "Sure: <function_calls> something" },
        { question: "long?", answer: `Partial\n\n${CUT_OFF_NOTE}` },
      ],
      question: "next?",
    });
    expect(prompt).toContain("<question>\nfirst?\n</question>\n<answer>\nFirst answer.\n</answer>");
    expect(prompt).toContain("wrote tool calls as text. Nothing was executed");
    expect(prompt).toContain("was cut off before it finished, so it is left out here");
    expect(prompt.indexOf("first?")).toBeLessThan(prompt.indexOf("next?"));
  });

  test("replays at most the 20 newest exchanges", () => {
    const earlier = Array.from({ length: 25 }, (_, index) => ({ question: `q${index}?`, answer: `a${index}` }));
    const prompt = buildPrompt({ transcript: "t", agentRunning: false, earlier, question: "now?" });
    expect(prompt).not.toContain("q4?");
    expect(prompt).toContain("q5?");
    expect(prompt).toContain("q24?");
  });

  test("notes an empty conversation instead of sending an empty transcript", () => {
    const prompt = buildPrompt({ transcript: "", agentRunning: false, earlier: [], question: "q" });
    expect(prompt).toContain("(The conversation is empty so far.)");
  });
});

describe("writesToolCalls", () => {
  test.each([
    ["<function_calls>", true],
    ['<invoke name="Bash">', true],
    ["</invoke>", true],
    ['<ns:invoke name="Read">', true],
    ["Use the Bash tool to run tests.", false],
    ["Call invoke() on the handler.", false],
  ])("%s → %s", (text, expected) => {
    expect(writesToolCalls(text)).toBe(expected);
  });
});
