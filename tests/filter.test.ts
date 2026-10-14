import { describe, expect, test } from "vitest";
import { countWords, normalizeSuggestion } from "../server/filter";

describe("normalizeSuggestion", () => {
  test.each([
    ["run the tests", "run the tests"],
    ["  commit this  ", "commit this"],
    ['"push it to main"', "push it to main"],
    ["“try it out”", "try it out"],
    ["<suggestion>run the tests</suggestion>", "run the tests"],
    ["Suggestion: run the tests", "run the tests"],
    ["建议：运行测试", "运行测试"],
    ["fix issue #42 next", "fix issue #42 next"],
    ["run `npm test` again", "run `npm test` again"],
    ["yes", "yes"],
    ["continue.", "continue."],
    ["继续", "继续"],
    ["/review", "/review"],
    ["Add type hints to add(). Nothing else.", "Add type hints to add(). Nothing else."],
    ["运行测试。然后提交", "运行测试。然后提交"],
    ["Sure, let's add that test file.", "Sure, let's add that test file."],
  ])("keeps %j as %j", (raw, expected) => {
    expect(normalizeSuggestion(raw)).toBe(expected);
  });

  test.each([
    ["empty", ""],
    ["null", null],
    ["no suggestion", "No suggestion."],
    ["nothing", "nothing"],
    ["chinese none", "无建议"],
    ["question", "what about the edge cases?"],
    ["chinese question", "要不要加测试？"],
    ["agent voice", "I'll run the tests now"],
    ["agent voice", "Let me check the logs"],
    ["agent voice", "Sure, I'll add the test file"],
    ["chinese agent voice", "我来运行测试"],
    ["evaluative", "looks good, thanks"],
    ["chinese evaluative", "谢谢，很好"],
    ["three sentences", "Run the tests. Then push. Then deploy."],
    ["three chinese sentences", "运行测试。然后提交。再部署"],
    ["multi line", "run the tests\npush it"],
    ["bold", "**run the tests**"],
    ["bullet", "- run the tests"],
    ["label", "Next: run the tests"],
    ["single unknown word", "tests"],
    ["too many words", "please go ahead and run every single one of the integration tests again now"],
    ["too long", "x".repeat(101)],
  ])("rejects %s", (_, raw) => {
    expect(normalizeSuggestion(raw)).toBeNull();
  });
});

describe("countWords", () => {
  test("counts space-separated and Chinese words", () => {
    expect(countWords("run the tests")).toBe(3);
    expect(countWords("运行测试")).toBeGreaterThanOrEqual(2);
  });
});
