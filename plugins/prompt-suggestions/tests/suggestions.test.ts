import { describe, expect, test } from "vitest";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { SuggestionSettings } from "../shared/settings";
import type { SuggestionRow } from "../shared/suggestion-row";
import {
  createSuggestionCoordinator,
  type GenerationRequest,
  type RowWriter,
} from "../server/suggestions";

type TurnEndedEvent = PluginLifecycleEvents["agent.turn_ended"];

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

function turnEnded(overrides: Partial<TurnEndedEvent> = {}): TurnEndedEvent {
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
    timeline: [
      { type: "user_message", text: "fix the bug" },
      { type: "assistant_message", text: "Fixed." },
      { type: "user_message", text: "and the other one" },
      { type: "assistant_message", text: "Done. Want me to run the tests?" },
    ],
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
    ["the first exchange", turnEnded({ timeline: turnEnded().timeline.slice(0, 2) })],
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
    await Promise.resolve();
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
    await Promise.resolve();
    hook.abort();
    expect(signals[0]?.aborted).toBe(true);
    reply.resolve("run the tests");
    await pending;
    expect(writes).toEqual([]);
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
