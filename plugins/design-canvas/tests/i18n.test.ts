import { describe, expect, test } from "vitest";
import en from "../client/locales/en.json";
import zhCN from "../client/locales/zh-CN.json";

const placeholders = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

describe("translations", () => {
  test("Chinese has every English key with the same placeholders", () => {
    const english = en as Record<string, string>;
    const chinese = zhCN as Record<string, string>;
    expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort());
    for (const [key, text] of Object.entries(english)) expect(placeholders(chinese[key]!), key).toEqual(placeholders(text));
  });
});
