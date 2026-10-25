import { afterEach, describe, expect, test, vi } from "vitest";
import { GENERATION_TIMEOUT_MS } from "../server/generate";
import type { SuggestionSettings } from "../shared/settings";
import type { SuggestionRow } from "../shared/suggestion-row";
import {
  createSuggestionCoordinator,
  type GenerationRequest,
  MAX_CONCURRENT_GENERATIONS,
  type RowWriter,
  type TurnEndedEvent,
} from "../server/suggestions";
import type { TimelineItem } from "../server/transcript";

interface Write {
  rowId: string;
  row: SuggestionRow;
}

function recorder(): { write: RowWriter; writes: Write[] } {
  const writes: Write[] = [];
  return {
    writes,
    write: async (rowId, row) => {
      writes.push({ rowId, row });
    },
  };
}

const conversation: TimelineItem[] = [
  { type: "user_message", text: "fix the bug" },
  { type: "assistant_message", text: "Fixed." },
  { type: "user_message", text: "and the other one" },
  { type: "assistant_message", text: "Done. Want me to run the tests?" },
];

function turnEnded(
  overrides: Partial<TurnEndedEvent> = {},
  items: readonly TimelineItem[] = conversation,
  hasOlder = false,
): TurnEndedEvent {
  return {
    agent: {
      id: "agent-1",
      workspaceId: "workspace-1",
      parentAgentId: null,
      provider: "claude",
      cwd: "/repo",
      title: null,
    },
    turnId: "turn-2",
    outcome: { kind: "completed" },
    readTimeline: async () => ({ items, hasOlder }),
    ...overrides,
  };
}

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

const defaults: SuggestionSettings = { providers: [], model: "haiku" };

function coordinatorReplying(
  reply: string | null | Promise<string | null>,
  settings: SuggestionSettings | null = defaults,
) {
  let next = 0;
  const requests: GenerationRequest[] = [];
  const signals: AbortSignal[] = [];
  const logs: string[] = [];
  const coordinator = createSuggestionCoordinator({
    settings: () => settings,
    generate: async (request) => {
      requests.push(request);
      signals.push(request.signal);
      return reply;
    },
    createRowId: () => `row-${++next}`,
    log: (message) => logs.push(message),
    logError: (message, error) => logs.push(`${message}: ${String(error)}`),
  });
  return { coordinator, requests, signals, logs };
}

const live = () => new AbortController().signal;

describe("suggestion coordinator", () => {
  test("publishes a ready row when a later turn completes", async () => {
    const { coordinator } = coordinatorReplying("run the tests");
    const { write, writes } = recorder();
    await coordinator.turnEnded(turnEnded(), write, live());
    expect(writes).toEqual([{ rowId: "row-1", row: { status: "ready", text: "run the tests" } }]);
  });

  test("dismisses the live row in place when the next turn opens", async () => {
    const { coordinator } = coordinatorReplying("run the tests");
    const { write, writes } = recorder();
    await coordinator.turnEnded(turnEnded(), write, live());
    await coordinator.invalidate("agent-1", write);
    await coordinator.invalidate("agent-1", write);
    expect(writes.at(-1)).toEqual({ rowId: "row-1", row: { status: "dismissed" } });
    expect(writes).toHaveLength(2);
  });

  test("uses a new row for each turn so the suggestion follows the conversation", async () => {
    const { coordinator } = coordinatorReplying("run the tests");
    const { write, writes } = recorder();
    await coordinator.turnEnded(turnEnded(), write, live());
    await coordinator.invalidate("agent-1", write);
    await coordinator.turnEnded(turnEnded({ turnId: "turn-3" }), write, live());
    expect(writes.map(({ rowId, row }) => `${rowId}:${row.status}`)).toEqual([
      "row-1:ready",
      "row-1:dismissed",
      "row-2:ready",
    ]);
  });

  test.each([
    ["the first exchange", turnEnded({}, conversation.slice(0, 2))],
    ["a failed turn", turnEnded({ outcome: { kind: "failed", error: { message: "boom" } } })],
    ["a canceled turn", turnEnded({ outcome: { kind: "canceled", reason: "user" } })],
    [
      "a subagent",
      turnEnded({ agent: { ...turnEnded().agent, parentAgentId: "parent-1" } }),
    ],
  ])("suggests nothing after %s", async (_, event) => {
    const { coordinator, signals } = coordinatorReplying("run the tests");
    const { write, writes } = recorder();
    await coordinator.turnEnded(event, write, live());
    expect(writes).toEqual([]);
    expect(signals).toHaveLength(0);
  });

  test("suggests when earlier history lies beyond the page that was read", async () => {
    const { coordinator } = coordinatorReplying("run the tests");
    const { write, writes } = recorder();
    await coordinator.turnEnded(turnEnded({}, conversation.slice(2), true), write, live());
    expect(writes).toEqual([{ rowId: "row-1", row: { status: "ready", text: "run the tests" } }]);
  });

  test("logs and skips the turn when the conversation cannot be read", async () => {
    const { coordinator, signals, logs } = coordinatorReplying("run the tests");
    const { write, writes } = recorder();
    const unreadable = turnEnded({
      readTimeline: async () => {
        throw new Error("agent not found");
      },
    });
    await coordinator.turnEnded(unreadable, write, live());
    expect(writes).toEqual([]);
    expect(signals).toHaveLength(0);
    expect(logs).toEqual(["Could not read the conversation of agent agent-1: Error: agent not found"]);
  });

  test("passes the transcript and the configured model to the generator", async () => {
    const { coordinator, requests } = coordinatorReplying("run the tests", {
      providers: [],
      model: "sonnet",
    });
    await coordinator.turnEnded(turnEnded(), recorder().write, live());
    expect(requests[0]?.model).toBe("sonnet");
    expect(requests[0]?.transcript).toContain("Want me to run the tests?");
  });

  test("suggests only for the configured providers", async () => {
    const { coordinator, signals } = coordinatorReplying("run the tests", {
      providers: ["claude"],
      model: "haiku",
    });
    const { write, writes } = recorder();
    const codex = turnEnded({ agent: { ...turnEnded().agent, id: "agent-2", provider: "codex" } });
    await coordinator.turnEnded(codex, write, live());
    expect(signals).toHaveLength(0);
    await coordinator.turnEnded(turnEnded(), write, live());
    expect(writes).toEqual([{ rowId: "row-1", row: { status: "ready", text: "run the tests" } }]);
  });

  test("suggests nothing while settings are unavailable", async () => {
    const { coordinator, signals } = coordinatorReplying("run the tests", null);
    const { write, writes } = recorder();
    await coordinator.turnEnded(turnEnded(), write, live());
    expect(writes).toEqual([]);
    expect(signals).toHaveLength(0);
  });

  test("drops replies the filter rejects and logs what the model said", async () => {
    const { coordinator, logs } = coordinatorReplying("Looks good, thanks!");
    const { write, writes } = recorder();
    await coordinator.turnEnded(turnEnded(), write, live());
    expect(writes).toEqual([]);
    expect(logs).toEqual(['No suggestion for agent agent-1: model replied "Looks good, thanks!"']);
  });

  test("logs a failed generation and still dismisses on the next turn", async () => {
    const logs: string[] = [];
    const coordinator = createSuggestionCoordinator({
      settings: () => defaults,
      generate: async () => {
        throw new Error("claude -p failed (exit 1): not logged in");
      },
      createRowId: () => "row-1",
      log: (message) => logs.push(message),
      logError: (message, error) => logs.push(`${message}: ${(error as Error).message}`),
    });
    const { write, writes } = recorder();
    await coordinator.turnEnded(turnEnded(), write, live());
    await coordinator.invalidate("agent-1", write);
    expect(writes).toEqual([]);
    expect(logs).toEqual([
      "Suggestion generation failed for agent agent-1: claude -p failed (exit 1): not logged in",
    ]);
  });

  test("abandons a generation when the next turn opens before it finishes", async () => {
    const reply = deferred<string | null>();
    const { coordinator, signals } = coordinatorReplying(reply.promise);
    const { write, writes } = recorder();
    const pending = coordinator.turnEnded(turnEnded(), write, live());
    await flushPromises();
    await coordinator.invalidate("agent-1", write);
    expect(signals[0]?.aborted).toBe(true);
    reply.resolve("run the tests");
    await pending;
    expect(writes).toEqual([]);
  });

  test("abandons a generation when the hook times out", async () => {
    const reply = deferred<string | null>();
    const { coordinator, signals } = coordinatorReplying(reply.promise);
    const { write, writes } = recorder();
    const hook = new AbortController();
    const pending = coordinator.turnEnded(turnEnded(), write, hook.signal);
    await flushPromises();
    hook.abort();
    expect(signals[0]?.aborted).toBe(true);
    reply.resolve("run the tests");
    await pending;
    expect(writes).toEqual([]);
  });

  test("generates nothing when the hook was cancelled before the generation started", async () => {
    const { coordinator, requests } = coordinatorReplying("run the tests");
    const { write, writes } = recorder();
    await coordinator.turnEnded(turnEnded(), write, live());
    const hook = new AbortController();
    // Cancelled while the previous suggestion is being dismissed, before any listener exists.
    const cancelling: RowWriter = async (rowId, row) => {
      hook.abort();
      await write(rowId, row);
    };
    await coordinator.turnEnded(turnEnded({ turnId: "turn-3" }), cancelling, hook.signal);
    expect(requests).toHaveLength(1);
    expect(writes.map(({ rowId, row }) => `${rowId}:${row.status}`)).toEqual([
      "row-1:ready",
      "row-1:dismissed",
    ]);
  });

  test("keeps working after a row write fails", async () => {
    const errors: string[] = [];
    const coordinator = createSuggestionCoordinator({
      settings: () => defaults,
      generate: async () => "run the tests",
      createRowId: () => "row-1",
      log: () => undefined,
      logError: (message) => errors.push(message),
    });
    const failing: RowWriter = async () => {
      throw new Error("Unknown agent");
    };
    await coordinator.turnEnded(turnEnded(), failing, live());
    expect(errors).toEqual(["Could not write suggestion row row-1"]);
  });
});

describe("generation limit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function coordinatorWaiting(settings: () => SuggestionSettings | null = () => defaults) {
    let next = 0;
    const runs: { request: GenerationRequest; reply: ReturnType<typeof deferred<string | null>> }[] =
      [];
    const logs: string[] = [];
    const coordinator = createSuggestionCoordinator({
      settings,
      generate: (request) => {
        const reply = deferred<string | null>();
        runs.push({ request, reply });
        return reply.promise;
      },
      createRowId: () => `row-${++next}`,
      log: (message) => logs.push(message),
      logError: (message, error) => logs.push(`${message}: ${String(error)}`),
    });
    return { coordinator, runs, logs };
  }

  const endedFor = (id: string) => turnEnded({ agent: { ...turnEnded().agent, id } });

  test("runs a limited number of generations at once and queues the rest in order", async () => {
    const { coordinator, runs } = coordinatorWaiting();
    const { write, writes } = recorder();
    const pending = ["agent-1", "agent-2", "agent-3"].map((id) =>
      coordinator.turnEnded(endedFor(id), write, live()),
    );
    await flushPromises();
    expect(MAX_CONCURRENT_GENERATIONS).toBe(2);
    expect(runs).toHaveLength(2);

    runs[0]?.reply.resolve("run the tests");
    await flushPromises();
    expect(runs).toHaveLength(3);
    expect(runs[2]?.request.transcript).toContain("Want me to run the tests?");

    runs[1]?.reply.resolve("run the tests");
    runs[2]?.reply.resolve("commit it");
    await Promise.all(pending);
    expect(writes.map(({ rowId, row }) => `${rowId}:${row.status}`)).toEqual([
      "row-1:ready",
      "row-2:ready",
      "row-3:ready",
    ]);
  });

  test.each([
    ["the next turn opens", "invalidate"],
    ["the hook is aborted", "hook"],
  ] as const)("drops a queued generation when %s", async (_, cancel) => {
    const { coordinator, runs } = coordinatorWaiting();
    const { write, writes } = recorder();
    const busy = ["agent-1", "agent-2"].map((id) =>
      coordinator.turnEnded(endedFor(id), write, live()),
    );
    const hook = new AbortController();
    const queued = coordinator.turnEnded(endedFor("agent-3"), write, hook.signal);
    await flushPromises();

    if (cancel === "invalidate") await coordinator.invalidate("agent-3", write);
    else hook.abort();
    await queued;
    for (const run of runs) run.reply.resolve("run the tests");
    await Promise.all(busy);
    await flushPromises();

    expect(runs).toHaveLength(2);
    expect(writes.map(({ rowId }) => rowId)).toEqual(["row-1", "row-2"]);
  });

  test("applies settings saved while a generation waited for a slot", async () => {
    let settings = defaults;
    const { coordinator, runs, logs } = coordinatorWaiting(() => settings);
    const { write } = recorder();
    const busy = ["agent-1", "agent-2"].map((id) =>
      coordinator.turnEnded(endedFor(id), write, live()),
    );
    const codex = turnEnded({ agent: { ...turnEnded().agent, id: "agent-3", provider: "codex" } });
    const queuedCodex = coordinator.turnEnded(codex, write, live());
    const queuedClaude = coordinator.turnEnded(endedFor("agent-4"), write, live());
    await flushPromises();

    settings = { providers: ["claude"], model: "sonnet" };
    runs[0]?.reply.resolve("run the tests");
    await queuedCodex;
    await flushPromises();

    // The Codex conversation is never sent; the queued Claude one runs on the new model.
    expect(runs.map((run) => run.request.model)).toEqual(["haiku", "haiku", "sonnet"]);
    expect(logs).toContain("No suggestion for agent agent-3: settings changed while it waited");
    for (const run of runs) run.reply.resolve("run the tests");
    await Promise.all([...busy, queuedClaude]);
  });

  test("gives up waiting before the budget runs out", async () => {
    vi.useFakeTimers();
    const { coordinator, runs, logs } = coordinatorWaiting();
    const { write, writes } = recorder();
    const busy = ["agent-1", "agent-2"].map((id) =>
      coordinator.turnEnded(endedFor(id), write, live()),
    );
    const queued = coordinator.turnEnded(endedFor("agent-3"), write, live());
    await flushPromises();

    await vi.advanceTimersByTimeAsync(GENERATION_TIMEOUT_MS);
    await queued;
    expect(logs).toEqual(["No suggestion for agent agent-3: no free slot in time"]);

    for (const run of runs) run.reply.resolve("run the tests");
    await Promise.all(busy);
    expect(runs).toHaveLength(2);
    expect(writes).toHaveLength(2);
  });

  test("leaves a queued generation only what is left of the budget", async () => {
    vi.useFakeTimers();
    const { coordinator, runs } = coordinatorWaiting();
    const { write } = recorder();
    const pending = ["agent-1", "agent-2", "agent-3"].map((id) =>
      coordinator.turnEnded(endedFor(id), write, live()),
    );
    await flushPromises();
    expect(runs[0]?.request.timeoutMs).toBe(GENERATION_TIMEOUT_MS);

    await vi.advanceTimersByTimeAsync(4_000);
    runs[0]?.reply.resolve("run the tests");
    await flushPromises();
    expect(runs[2]?.request.timeoutMs).toBe(GENERATION_TIMEOUT_MS - 4_000);

    for (const run of runs) run.reply.resolve("run the tests");
    await Promise.all(pending);
  });
});
