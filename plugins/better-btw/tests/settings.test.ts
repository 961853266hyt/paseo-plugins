import { describe, expect, test } from "vitest";
import {
  FALLBACK_MODEL,
  modelFor,
  SAME_AS_AGENT,
  sideQuestionSettings,
} from "../shared/settings";

describe("sideQuestionSettings", () => {
  test("defaults to the agent's own model", () => {
    expect(sideQuestionSettings.schema.parse({})).toEqual({ model: SAME_AS_AGENT });
  });

  test("rejects a model that would read as a command-line flag", () => {
    expect(sideQuestionSettings.schema.safeParse({ model: "--help" }).success).toBe(false);
    expect(sideQuestionSettings.schema.safeParse({ model: "claude opus" }).success).toBe(false);
  });
});

describe("modelFor", () => {
  const sameAsAgent = { model: SAME_AS_AGENT };

  test("follows a Claude agent's model", () => {
    expect(modelFor(sameAsAgent, { provider: "claude", model: "claude-opus-5-5" })).toBe("claude-opus-5-5");
  });

  test("leaves a Claude agent on its provider default to Claude Code's default", () => {
    expect(modelFor(sameAsAgent, { provider: "claude", model: null })).toBeNull();
  });

  test("answers for other providers with the fallback model", () => {
    expect(modelFor(sameAsAgent, { provider: "codex", model: "gpt-5" })).toBe(FALLBACK_MODEL);
  });

  test("never passes on a model that would read as a flag", () => {
    expect(modelFor(sameAsAgent, { provider: "claude", model: "-x" })).toBe(FALLBACK_MODEL);
  });

  test("uses the chosen model for every agent", () => {
    expect(modelFor({ model: "haiku" }, { provider: "claude", model: "claude-opus-5-5" })).toBe("haiku");
    expect(modelFor({ model: "haiku" }, { provider: "codex", model: null })).toBe("haiku");
  });
});
