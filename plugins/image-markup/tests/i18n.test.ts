import { describe, expect, test } from "vitest";
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

const placeholders = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

describe("translations", () => {
  test("Chinese has every English key with the same placeholders", () => {
    const english = leaves(en);
    const chinese = leaves(zhCN);
    expect([...chinese.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, text] of english) expect(placeholders(chinese.get(key)!), key).toEqual(placeholders(text));
  });

  test("English is used where the app has no translations", async () => {
    const { textNow } = await import("../client/i18n");
    const client = {} as Parameters<typeof textNow>[0];
    expect(textNow(client, "errors.loadFailed", { error: "boom" })).toBe("Could not open this image: boom");
  });
});
