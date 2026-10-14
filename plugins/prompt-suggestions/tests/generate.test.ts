import { describe, expect, test, vi } from "vitest";
import {
  buildClaudeArgs,
  type ClaudeRun,
  ClaudeRunError,
  type ClaudeRunner,
  generateSuggestion,
  parseClaudeOutput,
} from "../server/generate";

describe("buildClaudeArgs", () => {
  test("runs the requested model headless, without tools, MCP servers, hooks, settings or a session", () => {
    const args = buildClaudeArgs("haiku");
    expect(args.slice(0, 3)).toEqual(["-p", "--model", "haiku"]);
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("*");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(JSON.parse(args[args.indexOf("--settings") + 1]!)).toEqual({ disableAllHooks: true });
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
  });
});

describe("parseClaudeOutput", () => {
  test("returns the result text of a successful run", () => {
    expect(parseClaudeOutput('{"type":"result","subtype":"success","result":"run the tests"}')).toEqual(
      { ok: true, text: "run the tests" },
    );
  });

  test("tolerates noise before the JSON object", () => {
    expect(parseClaudeOutput('warning\n{"subtype":"success","result":"commit"}')).toEqual({
      ok: true,
      text: "commit",
    });
  });

  test.each([
    ["an error flag", '{"is_error":true,"result":"Invalid API key"}', "Invalid API key"],
    ["an error subtype", '{"subtype":"error_max_turns"}', "error_max_turns"],
    ["a truncated reply", '{"subtype":"success","stop_reason":"max_tokens","result":"run"}', "reply cut off"],
    ["plain text", "plain text", ""],
    ["broken JSON", '{"result":', "unreadable JSON output"],
  ])("reports %s as a failure", (_, stdout, reason) => {
    expect(parseClaudeOutput(stdout)).toEqual({ ok: false, reason });
  });
});

describe("generateSuggestion", () => {
  function fakeRunner(stdout: string, exitCode: number | null = 0) {
    const runs: ClaudeRun[] = [];
    const runner: ClaudeRunner = vi.fn(async (run: ClaudeRun) => {
      runs.push(run);
      return { stdout, stderr: "Error: not logged in\n", exitCode };
    });
    return { runner, runs };
  }

  test("sends the transcript on stdin and returns the reply", async () => {
    const { runner, runs } = fakeRunner('{"subtype":"success","result":"run the tests"}');
    const reply = await generateSuggestion({
      transcript: "User: fix it\nAssistant: Fixed. Run the tests?",
      model: "haiku",
      signal: new AbortController().signal,
      runner,
    });
    expect(reply).toBe("run the tests");
    expect(runs[0]?.stdin).toContain("User: fix it\nAssistant: Fixed. Run the tests?");
    expect(runs[0]?.cwd).toContain("paseo-prompt-suggestions-");
    expect(runs[0]?.timeoutMs).toBeLessThan(30_000);
  });

  test("throws the CLI's reason when it exits with an error", async () => {
    const { runner } = fakeRunner("", 1);
    const run = generateSuggestion({
      transcript: "User: hi",
      model: "haiku",
      signal: new AbortController().signal,
      runner,
    });
    await expect(run).rejects.toBeInstanceOf(ClaudeRunError);
    await expect(run).rejects.toThrow("claude -p failed (exit 1): Error: not logged in");
  });

  test("throws the result's reason when the run reports an error", async () => {
    const { runner } = fakeRunner('{"is_error":true,"result":"Invalid API key"}', 1);
    await expect(
      generateSuggestion({
        transcript: "User: hi",
        model: "haiku",
        signal: new AbortController().signal,
        runner,
      }),
    ).rejects.toThrow("Invalid API key");
  });

  test("returns null once aborted", async () => {
    const controller = new AbortController();
    const runner: ClaudeRunner = async () => {
      controller.abort();
      return { stdout: "", stderr: "", exitCode: null };
    };
    const reply = await generateSuggestion({
      transcript: "User: hi",
      model: "haiku",
      signal: controller.signal,
      runner,
    });
    expect(reply).toBeNull();
  });
});
