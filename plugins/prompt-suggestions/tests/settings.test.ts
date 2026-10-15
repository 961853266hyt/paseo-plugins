import { describe, expect, test } from "vitest";
import { suggestionSettings, suggestsFor } from "../shared/settings";

describe("suggestion settings", () => {
  test("default to every provider and Haiku, as before settings existed", () => {
    expect(suggestionSettings.schema.parse({})).toEqual({ providers: [], model: "haiku" });
  });

  test("reject a model that would read as a flag or split into two arguments", () => {
    expect(suggestionSettings.schema.safeParse({ model: "--bare" }).success).toBe(false);
    expect(suggestionSettings.schema.safeParse({ model: "claude haiku" }).success).toBe(false);
    expect(suggestionSettings.schema.parse({ model: " claude-haiku-4-5 " }).model).toBe(
      "claude-haiku-4-5",
    );
  });

  test("suggest for every provider when none is listed", () => {
    expect(suggestsFor({ providers: [], model: "haiku" }, "opencode")).toBe(true);
    expect(suggestsFor({ providers: ["claude"], model: "haiku" }, "claude")).toBe(true);
    expect(suggestsFor({ providers: ["claude"], model: "haiku" }, "codex")).toBe(false);
  });
});
