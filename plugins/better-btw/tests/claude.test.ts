import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import {
  ANSWER_TIMEOUT_MS,
  answerWithClaude,
  buildClaudeArgs,
  type ClaudeExit,
  type ClaudeRun,
  createStreamParser,
  settle,
} from "../server/claude";
import { CUT_OFF_NOTE, SYSTEM_PROMPT, TOOLS_NOTE } from "../server/prompt";

const cleanExit: ClaudeExit = { exitCode: 0, stderr: "", timedOut: false, spawnError: null };
const files = { systemPrompt: "/tmp/run/system-prompt.md", settings: "/tmp/run/settings.json" };

function delta(text: string): string {
  return JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  });
}

function assistant(content: unknown[], model = "claude-sonnet-5-5"): string {
  return JSON.stringify({ type: "assistant", message: { model, content } });
}

function result(fields: Record<string, unknown>): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, ...fields });
}

function parse(lines: string[]) {
  const parser = createStreamParser();
  for (const line of lines) parser.push(line);
  return parser.state;
}

describe("buildClaudeArgs", () => {
  test("streams a headless run without tools, MCP servers, hooks, CLAUDE.md or a saved session", () => {
    const args = buildClaudeArgs("claude-opus-5-5", files);
    expect(args.slice(0, 3)).toEqual(["-p", "--model", "claude-opus-5-5"]);
    expect(args[args.indexOf("--system-prompt-file") + 1]).toBe(files.systemPrompt);
    expect(args[args.indexOf("--settings") + 1]).toBe(files.settings);
    expect(args).toContain("--tools=");
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("*");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--include-partial-messages");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    // Settings must load: they can hold the sign-in, gateway or proxy the CLI needs.
    expect(args).not.toContain("--setting-sources");
  });

  test("keeps every argument non-empty and on one line, which cmd.exe needs on Windows", () => {
    for (const arg of buildClaudeArgs("sonnet", files)) {
      expect(arg).not.toBe("");
      expect(arg).not.toMatch(/[\r\n]/);
    }
  });

  test("leaves the model to Claude Code when none is given", () => {
    expect(buildClaudeArgs(null, files)).not.toContain("--model");
  });
});

describe("createStreamParser", () => {
  test("adds up text deltas and counts the final assistant message once", () => {
    const parser = createStreamParser();
    expect(parser.push(delta("The config "))).toBe(true);
    expect(parser.push(delta("is vite.config.ts."))).toBe(true);
    expect(parser.push(assistant([{ type: "text", text: "The config is vite.config.ts." }]))).toBe(false);
    expect(parser.state.text).toBe("The config is vite.config.ts.");
    expect(parser.state.model).toBe("claude-sonnet-5-5");
  });

  test("takes the text from the assistant message when nothing streamed", () => {
    expect(parse([assistant([{ type: "text", text: "Whole answer." }])]).text).toBe("Whole answer.");
  });

  test("notices a tool the model tried to call and the model from the init line", () => {
    const state = parse([
      JSON.stringify({ type: "system", subtype: "init", model: "claude-haiku-5-5" }),
      assistant([{ type: "tool_use", name: "Read", input: {} }], "claude-haiku-5-5"),
    ]);
    expect(state.attemptedTool).toBe("Read");
    expect(state.model).toBe("claude-haiku-5-5");
  });

  test("ignores noise and thinking", () => {
    const state = parse([
      "warning: something",
      "{broken",
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
      }),
    ]);
    expect(state.text).toBe("");
  });
});

describe("settle", () => {
  test("returns the answer of a successful run", () => {
    const state = parse([delta("Answer."), result({ result: "Answer.", stop_reason: "end_turn" })]);
    expect(settle(state, cleanExit, false)).toEqual({
      kind: "answered",
      text: "Answer.",
      model: null,
      replayable: true,
    });
  });

  test("marks an answer cut off by the token limit", () => {
    const state = parse([result({ result: "Partial", stop_reason: "max_tokens" })]);
    expect(settle(state, cleanExit, false)).toMatchObject({ text: `Partial\n\n${CUT_OFF_NOTE}` });
  });

  test("warns when the answer writes tool calls as text", () => {
    const state = parse([result({ result: "<function_calls>run</function_calls>" })]);
    const outcome = settle(state, cleanExit, false);
    expect(outcome).toMatchObject({ kind: "answered", replayable: true });
    expect(outcome.kind === "answered" && outcome.text.endsWith(TOOLS_NOTE)).toBe(true);
  });

  test("explains a tool attempt that left no answer and keeps it out of later replays", () => {
    const state = parse([assistant([{ type: "tool_use", name: "Grep" }]), result({ result: "" })]);
    expect(settle(state, cleanExit, false)).toMatchObject({ kind: "answered", replayable: false });
  });

  test("reports an error result", () => {
    const state = parse([result({ is_error: true, result: "Not logged in · Please run /login" })]);
    expect(settle(state, { ...cleanExit, exitCode: 1 }, false)).toEqual({
      kind: "failed",
      error: "Not logged in · Please run /login",
      model: null,
    });
  });

  test("keeps what streamed before the run broke off, marked as cut off", () => {
    const state = parse([delta("Half an ans")]);
    expect(settle(state, { ...cleanExit, exitCode: null, timedOut: true }, false)).toMatchObject({
      kind: "answered",
      text: `Half an ans\n\n${CUT_OFF_NOTE}`,
    });
  });

  test("reports a stop with whatever had arrived", () => {
    expect(settle(parse([delta("Some")]), cleanExit, true)).toEqual({ kind: "stopped", text: "Some" });
  });

  test.each([
    [{ spawnError: "spawn claude ENOENT" }, "The Claude Code CLI (claude) was not found on the daemon host's PATH."],
    [{ exitCode: null, timedOut: true }, `No answer within ${ANSWER_TIMEOUT_MS / 60_000} minutes.`],
    [{ exitCode: 1, stderr: "first\nError: rate limited\n" }, "Error: rate limited"],
    [{ exitCode: 2 }, "Claude Code exited with code 2 and no answer."],
  ])("explains a run without output: %o", (exit, error) => {
    expect(settle(parse([]), { ...cleanExit, ...exit }, false)).toMatchObject({ kind: "failed", error });
  });
});

describe("answerWithClaude", () => {
  test("sends the prompt on stdin from an empty directory and reports the growing answer", async () => {
    const runs: ClaudeRun[] = [];
    const seen: string[] = [];
    const outcome = await answerWithClaude({
      prompt: "the prompt",
      model: "sonnet",
      signal: new AbortController().signal,
      onText: (text) => seen.push(text),
      runner: vi.fn(async (run: ClaudeRun) => {
        runs.push(run);
        const promptFile = run.args[run.args.indexOf("--system-prompt-file") + 1]!;
        const settingsFile = run.args[run.args.indexOf("--settings") + 1]!;
        expect(readFileSync(promptFile, "utf8")).toBe(SYSTEM_PROMPT);
        expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toEqual({
          disableAllHooks: true,
          env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" },
        });
        expect(promptFile.startsWith(run.cwd)).toBe(true);
        run.onLine(delta("One "));
        run.onLine(delta("two."));
        run.onLine(result({ result: "One two." }));
        return cleanExit;
      }),
    });
    expect(outcome).toMatchObject({ kind: "answered", text: "One two." });
    expect(seen).toEqual(["One ", "One two."]);
    expect(runs[0]!.stdin).toBe("the prompt");
    expect(runs[0]!.args.slice(0, 3)).toEqual(["-p", "--model", "sonnet"]);
    expect(runs[0]!.timeoutMs).toBe(ANSWER_TIMEOUT_MS);
    expect(existsSync(runs[0]!.cwd)).toBe(false);
  });
});
