import { describe, expect, test } from "vitest";
import { createSuggestionStore, needsCard } from "../client/suggestion-store";

describe("suggestion store", () => {
  test("keeps the newest suggestion per agent", () => {
    const store = createSuggestionStore();
    store.offer("agent-1", "run the tests", 200);
    store.offer("agent-1", "commit this", 100);
    expect(store.get("agent-1")?.text).toBe("run the tests");
    store.offer("agent-1", "push it", 300);
    expect(store.get("agent-1")).toEqual({ text: "push it", at: 300, composer: "pending" });
  });

  test("a dismissed row retires the suggestion it replaced but not a newer one", () => {
    const store = createSuggestionStore();
    store.offer("agent-1", "run the tests", 200);
    store.retire("agent-1", 150);
    expect(store.get("agent-1")?.text).toBe("run the tests");
    store.retire("agent-1", 250);
    expect(store.get("agent-1")).toBeUndefined();
  });

  test("notifies listeners only on real changes", () => {
    const store = createSuggestionStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.offer("agent-1", "run the tests", 100);
    store.offer("agent-1", "run the tests", 100);
    store.setComposerState("agent-1", "shown");
    store.setComposerState("agent-1", "shown");
    store.remove("agent-1");
    store.remove("agent-1");
    unsubscribe();
    store.offer("agent-1", "commit", 200);
    expect(calls).toBe(3);
  });
});

describe("needsCard", () => {
  test.each([
    ["desktop web with the placeholder shown", { bridgeSupported: true, compact: false, composer: "shown" }, false],
    ["desktop web before the bridge has looked", { bridgeSupported: true, compact: false, composer: "pending" }, false],
    ["desktop web the bridge cannot reach", { bridgeSupported: true, compact: false, composer: "unavailable" }, true],
    ["phone-sized web, where there is no Tab key", { bridgeSupported: true, compact: true, composer: "shown" }, true],
    ["native apps", { bridgeSupported: false, compact: true, composer: "pending" }, true],
    ["native tablets", { bridgeSupported: false, compact: false, composer: "pending" }, true],
  ] as const)("%s → %s", (_, placement, expected) => {
    expect(needsCard(placement)).toBe(expected);
  });
});

describe("compact layout", () => {
  test("starts wide and notifies only when the layout changes", () => {
    const store = createSuggestionStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    expect(store.isCompact()).toBe(false);
    store.setCompact(true);
    store.setCompact(true);
    expect(store.isCompact()).toBe(true);
    store.setCompact(false);
    expect(calls).toBe(2);
  });
});
