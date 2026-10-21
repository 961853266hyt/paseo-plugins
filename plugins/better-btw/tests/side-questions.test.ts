import { afterEach, describe, expect, test, vi } from "vitest";
import type { AnswerOutcome } from "../server/claude";
import type { AgentContext } from "../server/context";
import {
  type AnswerJob,
  createSideQuestionService,
  MAX_ANSWERING_PER_AGENT,
  MAX_CONCURRENT_ANSWERS,
  SLOT_WAIT_MS,
} from "../server/side-questions";
import { DEFAULT_SETTINGS, type SideQuestionSettings } from "../shared/settings";
import { MAX_QUESTION_CHARS, USAGE } from "../shared/thread";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Runs pending promise callbacks without relying on timers, which some tests fake. */
async function flushPromises(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const claudeAgent: AgentContext = {
  provider: "claude",
  model: "claude-opus-5-5",
  running: false,
  transcript: "[User]\nfix the bug",
};

function answered(text: string): AnswerOutcome {
  return { kind: "answered", text, model: "claude-opus-5-5", replayable: true };
}

function setup(options: { settings?: SideQuestionSettings; context?: AgentContext } = {}) {
  const jobs: AnswerJob[] = [];
  const replies: Array<ReturnType<typeof deferred<AnswerOutcome>>> = [];
  let next = 0;
  const service = createSideQuestionService({
    settings: () => options.settings ?? DEFAULT_SETTINGS,
    answer: (job) => {
      jobs.push(job);
      const reply = deferred<AnswerOutcome>();
      replies.push(reply);
      return reply.promise;
    },
    createId: () => `x${++next}`,
    now: () => 1_000,
    log: () => {},
    logError: () => {},
  });
  const load = vi.fn(async () => options.context ?? claudeAgent);
  return { service, jobs, replies, load };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ask", () => {
  test("answers with the agent's model and streams the answer into the thread", async () => {
    const { service, jobs, replies, load } = setup();
    const id = service.ask("agent-1", "  which file?  ", load);
    await flushPromises();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.model).toBe("claude-opus-5-5");
    expect(jobs[0]!.prompt).toContain("[User]\nfix the bug");
    expect(jobs[0]!.prompt).toContain("<side_question>\nwhich file?\n</side_question>");

    jobs[0]!.onText("It is ");
    expect(service.thread("agent-1", null).focus).toMatchObject({ id, status: "answering", answer: "It is " });

    replies[0]!.resolve(answered("It is auth.ts."));
    await flushPromises();
    expect(service.thread("agent-1", null)).toEqual({
      exchanges: [{ id, question: "which file?", status: "answered" }],
      focus: {
        id,
        question: "which file?",
        status: "answered",
        answer: "It is auth.ts.",
        error: null,
        model: "claude-opus-5-5",
        askedAt: 1_000,
      },
    });
  });

  test("answers other agents with the fallback model", async () => {
    const { service, jobs, load } = setup({
      context: { ...claudeAgent, provider: "codex", model: "gpt-5" },
    });
    service.ask("agent-1", "why?", load);
    await flushPromises();
    expect(jobs[0]!.model).toBe("sonnet");
  });

  test("uses the model chosen in settings", async () => {
    const { service, jobs, load } = setup({ settings: { model: "haiku" } });
    service.ask("agent-1", "why?", load);
    await flushPromises();
    expect(jobs[0]!.model).toBe("haiku");
  });

  test("refuses an empty or oversized question", () => {
    const { service, load } = setup();
    expect(() => service.ask("agent-1", "   ", load)).toThrow(USAGE);
    expect(() => service.ask("agent-1", "x".repeat(MAX_QUESTION_CHARS + 1), load)).toThrow(/at most/);
    expect(load).not.toHaveBeenCalled();
  });

  test("replays earlier answers, but not failures or notices, and drops those on the next question", async () => {
    const { service, jobs, replies, load } = setup();
    service.ask("agent-1", "first?", load);
    await flushPromises();
    replies[0]!.resolve(answered("First answer."));
    await flushPromises();

    service.ask("agent-1", "second?", load);
    await flushPromises();
    replies[1]!.resolve({ kind: "failed", error: "Not logged in", model: null });
    await flushPromises();

    service.ask("agent-1", "third?", load);
    await flushPromises();
    replies[2]!.resolve({ kind: "answered", text: "(The model tried…)", model: null, replayable: false });
    await flushPromises();

    service.ask("agent-1", "fourth?", load);
    await flushPromises();
    expect(jobs[3]!.prompt).toContain("<question>\nfirst?\n</question>");
    expect(jobs[3]!.prompt).not.toContain("second?");
    expect(jobs[3]!.prompt).not.toContain("third?");
    expect(service.thread("agent-1", null).exchanges.map((exchange) => exchange.question)).toEqual([
      "first?",
      "fourth?",
    ]);
  });

  test("keeps the 20 newest answered side questions", async () => {
    const { service, replies, load } = setup();
    for (let index = 0; index < 22; index++) {
      service.ask("agent-1", `q${index}?`, load);
      await flushPromises();
      replies[index]!.resolve(answered(`a${index}`));
      await flushPromises();
    }
    const questions = service.thread("agent-1", null).exchanges.map((exchange) => exchange.question);
    expect(questions).toHaveLength(20);
    expect(questions[0]).toBe("q2?");
    expect(questions.at(-1)).toBe("q21?");
  });

  test("reports a conversation that cannot be read", async () => {
    const { service, load } = setup();
    load.mockRejectedValueOnce(new Error("The agent was not found."));
    service.ask("agent-1", "why?", load);
    await flushPromises();
    expect(service.thread("agent-1", null).focus).toMatchObject({
      status: "failed",
      error: "Could not answer: The agent was not found.",
    });
  });

  test("limits how many side questions one agent can have answering", async () => {
    const { service, load } = setup();
    for (let index = 0; index < MAX_ANSWERING_PER_AGENT; index++) service.ask("agent-1", `q${index}`, load);
    expect(() => service.ask("agent-1", "one more", load)).toThrow(/Wait for an earlier side question/);
    expect(() => service.ask("agent-2", "elsewhere", load)).not.toThrow();
  });
});

describe("concurrency", () => {
  test("runs a few side questions at once across agents and queues the rest", async () => {
    const { service, jobs, replies, load } = setup();
    for (let index = 0; index <= MAX_CONCURRENT_ANSWERS; index++) {
      service.ask(`agent-${index}`, "why?", load);
    }
    await flushPromises();
    expect(jobs).toHaveLength(MAX_CONCURRENT_ANSWERS);

    replies[0]!.resolve(answered("done"));
    await flushPromises();
    expect(jobs).toHaveLength(MAX_CONCURRENT_ANSWERS + 1);
  });

  test("gives up on a side question that waited too long for a slot", async () => {
    vi.useFakeTimers();
    const { service, jobs, load } = setup();
    for (let index = 0; index <= MAX_CONCURRENT_ANSWERS; index++) {
      service.ask(`agent-${index}`, "why?", load);
    }
    await flushPromises();
    await vi.advanceTimersByTimeAsync(SLOT_WAIT_MS);
    await flushPromises();
    expect(jobs).toHaveLength(MAX_CONCURRENT_ANSWERS);
    expect(service.thread(`agent-${MAX_CONCURRENT_ANSWERS}`, null).focus).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/Too many side questions/),
    });
  });
});

describe("stop, clear and forget", () => {
  test("stop aborts the run, keeps what arrived and ignores the late outcome", async () => {
    const { service, jobs, replies, load } = setup();
    const id = service.ask("agent-1", "why?", load);
    await flushPromises();
    jobs[0]!.onText("Because");
    service.stop("agent-1", id);
    expect(jobs[0]!.signal.aborted).toBe(true);
    replies[0]!.resolve(answered("Because of everything."));
    await flushPromises();
    expect(service.thread("agent-1", null).focus).toMatchObject({ status: "stopped", answer: "Because" });
  });

  test("clear keeps the current side question and any still answering", async () => {
    const { service, replies, load } = setup();
    service.ask("agent-1", "first?", load);
    await flushPromises();
    replies[0]!.resolve(answered("one"));
    await flushPromises();
    service.ask("agent-1", "second?", load);
    await flushPromises();
    replies[1]!.resolve(answered("two"));
    await flushPromises();
    service.ask("agent-1", "third?", load);
    await flushPromises();
    service.ask("agent-1", "fourth?", load);
    await flushPromises();
    replies[3]!.resolve(answered("four"));
    await flushPromises();

    service.clear("agent-1");
    expect(service.thread("agent-1", null).exchanges.map((exchange) => exchange.question)).toEqual([
      "third?",
      "fourth?",
    ]);
  });

  test("focus picks an exchange by id and falls back to the newest", async () => {
    const { service, load } = setup();
    const first = service.ask("agent-1", "first?", load);
    const second = service.ask("agent-1", "second?", load);
    expect(service.thread("agent-1", first).focus?.id).toBe(first);
    expect(service.thread("agent-1", "gone").focus?.id).toBe(second);
    expect(service.thread("agent-2", null)).toEqual({ exchanges: [], focus: null });
  });

  test("forget and dispose abort what is still answering", async () => {
    const { service, jobs, load } = setup();
    service.ask("agent-1", "why?", load);
    service.ask("agent-2", "why?", load);
    await flushPromises();
    service.forget("agent-1");
    expect(jobs[0]!.signal.aborted).toBe(true);
    expect(service.thread("agent-1", null).exchanges).toEqual([]);
    service.dispose();
    expect(jobs[1]!.signal.aborted).toBe(true);
  });
});
