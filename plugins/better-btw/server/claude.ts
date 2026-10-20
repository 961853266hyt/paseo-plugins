import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CUT_OFF_NOTE, SYSTEM_PROMPT, TOOLS_NOTE, toolAttemptNotice, writesToolCalls } from "./prompt";

/** A large model thinking over a long transcript can take a while; past this the run is killed. */
export const ANSWER_TIMEOUT_MS = 180_000;
const MAX_PENDING_LINE_CHARS = 4 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;
const MAX_DETAIL_CHARS = 300;

export interface ClaudeRun {
  args: string[];
  stdin: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** One line of `--output-format stream-json`. */
  onLine(line: string): void;
}

export interface ClaudeExit {
  exitCode: number | null;
  stderr: string;
  timedOut: boolean;
  /** Set when the CLI could not start at all, usually because it is not installed. */
  spawnError: string | null;
}

export type ClaudeRunner = (run: ClaudeRun) => Promise<ClaudeExit>;

/** Merged over the user's own settings, which still load: see `buildClaudeArgs`. */
const RUN_SETTINGS = { disableAllHooks: true, env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" } };

/** Written into the run's empty working directory and passed by path. */
export interface ClaudeFiles {
  systemPrompt: string;
  settings: string;
}

/**
 * Headless Claude Code with no tools, MCP servers, hooks, skills, CLAUDE.md, rules, memory or saved
 * session: a side question can only read what it is given, cannot act, and leaves no trace in the
 * user's history. Settings still load, since their `env` and `apiKeyHelper` are how some users
 * reach Anthropic, Bedrock, Vertex or a gateway. On Windows the CLI starts through cmd.exe, which
 * drops empty arguments and ends the command at a line break, so the multi-line system prompt and
 * the settings go in files and `--tools=` is one argument.
 */
export function buildClaudeArgs(model: string | null, files: ClaudeFiles): string[] {
  return [
    "-p",
    ...(model ? ["--model", model] : []),
    "--system-prompt-file",
    files.systemPrompt,
    "--tools=",
    "--disallowedTools",
    "*",
    "--strict-mcp-config",
    "--settings",
    files.settings,
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
}

export interface StreamState {
  /** Answer text received so far. */
  text: string;
  /** The model Claude Code reports, once it does. */
  model: string | null;
  /** The first tool the model tried to call, although it has none. */
  attemptedTool: string | null;
  result: ResultLine | null;
}

interface ResultLine {
  isError: boolean;
  subtype: string;
  text: string | null;
  stopReason: string | null;
}

export interface StreamParser {
  readonly state: StreamState;
  /** Reads one output line; true when the answer text grew. */
  push(line: string): boolean;
}

export function createStreamParser(): StreamParser {
  const state: StreamState = { text: "", model: null, attemptedTool: null, result: null };
  let sawTextDelta = false;
  return {
    state,
    push(line) {
      const event = parseLine(line);
      if (!event) return false;
      switch (event.type) {
        case "system":
          if (event.subtype === "init" && typeof event.model === "string") state.model = event.model;
          return false;
        case "stream_event": {
          const inner = asRecord(event.event);
          const delta = asRecord(inner?.delta);
          if (inner?.type !== "content_block_delta" || delta?.type !== "text_delta") return false;
          if (typeof delta.text !== "string" || delta.text.length === 0) return false;
          sawTextDelta = true;
          state.text += delta.text;
          return true;
        }
        case "assistant": {
          const message = asRecord(event.message);
          if (typeof message?.model === "string") state.model = message.model;
          const blocks = (Array.isArray(message?.content) ? message.content : []).map(asRecord);
          for (const block of blocks) {
            if (block?.type === "tool_use" && state.attemptedTool === null) {
              state.attemptedTool = typeof block.name === "string" ? block.name : "unknown";
            }
          }
          // Text already streamed as deltas arrives here again in full; count it once.
          if (sawTextDelta) return false;
          const text = blocks.map((block) => (block?.type === "text" ? String(block.text ?? "") : "")).join("");
          state.text += text;
          return text.length > 0;
        }
        case "result":
          state.result = {
            isError: event.is_error === true,
            subtype: typeof event.subtype === "string" ? event.subtype : "",
            text: typeof event.result === "string" ? event.result : null,
            stopReason: typeof event.stop_reason === "string" ? event.stop_reason : null,
          };
          return false;
        default:
          return false;
      }
    },
  };
}

export type AnswerOutcome =
  | {
      kind: "answered";
      text: string;
      model: string | null;
      /** False for a notice standing in for an answer; later side questions leave it out. */
      replayable: boolean;
    }
  | { kind: "failed"; error: string; model: string | null }
  | { kind: "stopped"; text: string };

export function settle(state: StreamState, exit: ClaudeExit, aborted: boolean): AnswerOutcome {
  const streamed = state.text.trim();
  if (aborted) return { kind: "stopped", text: streamed };
  const result = state.result;
  if (result && !result.isError && !result.subtype.startsWith("error")) {
    const text = (result.text ?? state.text).trim();
    if (text) return answered(text, state.model, result.stopReason === "max_tokens");
    if (state.attemptedTool) {
      return { kind: "answered", text: toolAttemptNotice(state.attemptedTool), model: state.model, replayable: false };
    }
    return { kind: "failed", error: "Claude Code returned an empty answer.", model: state.model };
  }
  // The run ended early. Like Claude Code, show what already arrived, marked as cut off.
  if (streamed) return answered(streamed, state.model, true);
  return { kind: "failed", error: failure(result, exit), model: state.model };
}

function answered(text: string, model: string | null, cutOff: boolean): AnswerOutcome {
  const notes = [...(writesToolCalls(text) ? [TOOLS_NOTE] : []), ...(cutOff ? [CUT_OFF_NOTE] : [])];
  return { kind: "answered", text: [text, ...notes].join("\n\n"), model, replayable: true };
}

function failure(result: ResultLine | null, exit: ClaudeExit): string {
  if (result) return clip(result.text || result.subtype || "Claude Code reported an error.");
  if (exit.spawnError) {
    return /ENOENT/.test(exit.spawnError)
      ? "The Claude Code CLI (claude) was not found on the daemon host's PATH."
      : clip(exit.spawnError);
  }
  if (exit.timedOut) return `No answer within ${ANSWER_TIMEOUT_MS / 60_000} minutes.`;
  return lastLine(exit.stderr) || `Claude Code exited with code ${exit.exitCode ?? "none"} and no answer.`;
}

export interface AnswerRequest {
  prompt: string;
  model: string | null;
  signal: AbortSignal;
  /** The whole answer so far, each time it grows. */
  onText(text: string): void;
  runner?: ClaudeRunner;
}

export async function answerWithClaude(request: AnswerRequest): Promise<AnswerOutcome> {
  const runner = request.runner ?? runClaude;
  // An empty working directory, so no project settings or files are picked up.
  const cwd = await mkdtemp(join(tmpdir(), "paseo-better-btw-"));
  const parser = createStreamParser();
  try {
    const files: ClaudeFiles = {
      systemPrompt: join(cwd, "system-prompt.md"),
      settings: join(cwd, "settings.json"),
    };
    await writeFile(files.systemPrompt, SYSTEM_PROMPT);
    await writeFile(files.settings, JSON.stringify(RUN_SETTINGS));
    const exit = await runner({
      args: buildClaudeArgs(request.model, files),
      stdin: request.prompt,
      cwd,
      timeoutMs: ANSWER_TIMEOUT_MS,
      signal: request.signal,
      onLine: (line) => {
        if (parser.push(line)) request.onText(parser.state.text);
      },
    });
    return settle(parser.state, exit, request.signal.aborted);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export const runClaude: ClaudeRunner = (run) =>
  new Promise<ClaudeExit>((resolve) => {
    const child = spawnProcess("claude", run.args, { cwd: run.cwd, stdio: "pipe" });
    let pending = "";
    let stderr = "";
    let spawnError: string | null = null;
    let timedOut = false;
    let settled = false;

    function stop(): void {
      void terminateProcess(child, "SIGKILL").catch(() => undefined);
    }
    function emit(line: string): void {
      try {
        run.onLine(line);
      } catch {
        // One unreadable line must not end the run; the result line still decides.
      }
    }
    function finish(exitCode: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.signal.removeEventListener("abort", stop);
      if (pending) emit(pending);
      pending = "";
      resolve({ exitCode, stderr, timedOut, spawnError });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, run.timeoutMs);
    run.signal.addEventListener("abort", stop, { once: true });
    if (run.signal.aborted) stop();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        emit(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_PENDING_LINE_CHARS) {
        pending = "";
        stop();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
    });
    child.on("error", (error) => {
      spawnError = error.message;
      finish(null);
    });
    child.on("close", (code) => finish(code));
    // A CLI that exits before reading stdin closes the pipe early; the result line still decides.
    child.stdin.on("error", () => undefined);
    child.stdin.end(run.stdin);
  });

function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function lastLine(text: string): string {
  return clip(text.trim().split("\n").at(-1) ?? "");
}

function clip(text: string): string {
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;
}
