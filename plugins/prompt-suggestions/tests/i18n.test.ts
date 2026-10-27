import { afterEach, describe, expect, test, vi } from "vitest";
import en from "../client/locales/en.json";
import zhCN from "../client/locales/zh-CN.json";

type Resource = { readonly [key: string]: string | Resource };

function leaves(resource: Resource, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(resource)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else for (const [inner, text] of leaves(value, path)) out.set(inner, text);
  }
  return out;
}

const placeholders = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);

afterEach(() => {
  vi.doUnmock("@getpaseo/plugin/client");
  vi.resetModules();
});

describe("translations", () => {
  test("Chinese covers every English text with the same placeholders", () => {
    const english = leaves(en);
    const chinese = leaves(zhCN);
    expect([...chinese.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, text] of english) {
      expect(placeholders(chinese.get(key)!), key).toEqual(placeholders(text));
    }
  });

  test("Paseo accepts the resources and labels become messages", async () => {
    const { label } = await import("../client/i18n");
    // A message is resolved by the app in its own language; a string would mean no translation.
    expect(typeof label("settingsScreen")).toBe("object");
    expect(typeof label("card.sendLabel", { text: "run the tests" })).toBe("object");
  });

  test("apps without translations get English text", async () => {
    // An app before 0.13 has neither export; reading one gives undefined.
    vi.doMock("@getpaseo/plugin/client", () => ({
      defineTranslations: undefined,
      useTranslation: undefined,
    }));
    const { label, useText } = await import("../client/i18n");
    expect(label("settingsScreen")).toBe("Settings");
    expect(useText()("card.sendFailed", { error: "offline" })).toBe(
      "Could not send the suggestion: offline",
    );
  });
});
