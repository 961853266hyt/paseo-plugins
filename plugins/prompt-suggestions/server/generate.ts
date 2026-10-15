import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Budget for one suggestion, time spent waiting for a free slot included. Below the daemon's 30
 * second hook timeout, so a slow model never outlives its hook.
 */
export const GENERATION_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_CHARS = 256 * 1024;
const MAX_DETAIL_CHARS = 300;

const SYSTEM_PROMPT = `You predict the next message a developer will send to their AI coding agent.
You receive the recent conversation between the developer (User) and the agent (Assistant).
Reply with the message the developer is most likely to type next, worded the way they write:
same language, same tone, same brevity, one short sentence of 2 to 12 words.
Only predict a step the conversation already points to, such as accepting an option the agent
offered, running what the agent proposed, or the obvious next action after finished work.
Reply with nothing when the next step is unclear, when the agent failed or misunderstood, or when
the topic involves credentials, security incidents, private data or anything risky.
Never write as the agent, never ask a question, never thank or praise, never introduce new ideas,
and never add quotes, labels, explanations or formatting.`;

export interface ClaudeRun {
  args: string[];
  stdin: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface ClaudeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** The CLI ran but gave no answer: not installed, signed out, rate limited, timed out. */
export class ClaudeRunError extends Error {
  readonly exitCode: number | null;
  readonly detail: string;

  constructor(exitCode: number | null, detail: string) {
    super(`claude -p failed (exit ${exitCode ?? "none"}): ${detail}`);
    this.name = "ClaudeRunError";
    this.exitCode = exitCode;
    this.detail = detail;
  }
}

export type ClaudeRunner = (run: ClaudeRun) => Promise<ClaudeRunResult>;

export interface GenerateInput {
  transcript: string;
  model: string;
  signal: AbortSignal;
  /** What is left of the budget; defaults to all of it. */
  timeoutMs?: number;
  runner?: ClaudeRunner;
}

/**
 * Raw reply text from the model, or null when the run was aborted. Throws `ClaudeRunError` when
 * the CLI produced no answer, so the reason reaches the plugin log.
 */
export async function generateSuggestion(input: GenerateInput): Promise<string | null> {
  const runner = input.runner ?? runClaude;
  const cwd = await mkdtemp(join(tmpdir(), "paseo-prompt-suggestions-"));
  try {
    const result = await runner({
      args: buildClaudeArgs(input.model),
      stdin: `Conversation:\n${input.transcript}\n\nThe developer's next message:`,
      cwd,
      timeoutMs: input.timeoutMs ?? GENERATION_TIMEOUT_MS,
      signal: input.signal,
    });
    if (input.signal.aborted) return null;
    const output = parseClaudeOutput(result.stdout);
    if (result.exitCode === 0 && output.ok) return output.text;
    const reason = output.ok ? "" : output.reason;
    throw new ClaudeRunError(result.exitCode, reason || lastLine(result.stderr) || "no output");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * Headless, tool-less Claude Code run: no MCP servers, hooks, skills or saved session, so the
 * prediction never acts and never touches the user's conversation. No CLAUDE.md, rules or memory
 * files either, so the user's personal instructions stay out of the prompt. Settings still load:
 * their `env` and `apiKeyHelper` are how some users sign in or reach Bedrock, Vertex, a gateway or
 * a proxy, which `--setting-sources ""` and `--bare` would drop. The flag set follows PromptKit
 * (MIT, github.com/hungcuong9125/paseo-prompt-kit).
 */
export function buildClaudeArgs(model: string): string[] {
  return [
    "-p",
    "--model",
    model,
    "--system-prompt",
    SYSTEM_PROMPT,
    "--tools",
    "",
    "--disallowedTools",
    "*",
    "--strict-mcp-config",
    "--settings",
    JSON.stringify({ disableAllHooks: true, env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" } }),
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format",
    "json",
  ];
}

interface ClaudeJsonResult {
  is_error?: unknown;
  subtype?: unknown;
  stop_reason?: unknown;
  result?: unknown;
}

export type ClaudeOutput = { ok: true; text: string } | { ok: false; reason: string };

/** `claude -p --output-format json` prints one result object; errors also print one. */
export function parseClaudeOutput(stdout: string): ClaudeOutput {
  const start = stdout.indexOf("{");
  if (start === -1) return { ok: false, reason: "" };
  let parsed: ClaudeJsonResult;
  try {
    parsed = JSON.parse(stdout.slice(start)) as ClaudeJsonResult;
  } catch {
    return { ok: false, reason: "unreadable JSON output" };
  }
  const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "";
  const result = typeof parsed.result === "string" ? parsed.result : null;
  if (parsed.is_error === true || subtype.startsWith("error")) {
    return { ok: false, reason: clip(result ?? (subtype || "error result")) };
  }
  if (parsed.stop_reason === "max_tokens") return { ok: false, reason: "reply cut off" };
  if (result === null) return { ok: false, reason: "result missing" };
  return { ok: true, text: result };
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return clip(lines.at(-1) ?? "");
}

function clip(text: string): string {
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;
}

export const runClaude: ClaudeRunner = (run) =>
  new Promise<ClaudeRunResult>((resolve) => {
    const child = spawnProcess("claude", run.args, { cwd: run.cwd, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    let settled = false;

    function stop(): void {
      void terminateProcess(child, "SIGKILL").catch(() => undefined);
    }
    function settle(exitCode: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.signal.removeEventListener("abort", stop);
      resolve({ stdout, stderr, exitCode });
    }

    const timer = setTimeout(stop, run.timeoutMs);
    run.signal.addEventListener("abort", stop, { once: true });
    if (run.signal.aborted) stop();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_CHARS) stop();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += error.message;
      settle(null);
    });
    child.on("close", (code) => settle(code));
    // A CLI that exits before reading stdin closes the pipe early; the run result still decides.
    child.stdin.on("error", () => undefined);
    child.stdin.end(run.stdin);
  });
