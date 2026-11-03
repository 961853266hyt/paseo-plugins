import * as sdk from "@getpaseo/plugin/client";
import type { PluginClientContext, PluginTranslations } from "@getpaseo/plugin/client";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

type Resource = typeof en;
export type TextKey = Parameters<PluginTranslations<Resource>["message"]>[0];
type Values = Readonly<Record<string, string>>;

/**
 * Paseo 0.13 added plugin translations. Older apps supply none of these exports, so the plugin
 * shows its English text there instead.
 */
const messages: PluginTranslations<Resource> | null =
  typeof sdk.defineTranslations === "function"
    ? sdk.defineTranslations({ resources: { en, "zh-CN": zhCN } })
    : null;

/** Text for the plugin's own DOM, in the app's language at the moment it is built. */
export function textNow(client: PluginClientContext, key: TextKey, values?: Values): string {
  if (!messages || !client.i18n) return english(key, values);
  const t = client.i18n.t as (
    messages: PluginTranslations<Resource>,
    key: TextKey,
    values?: Values,
  ) => string;
  return t.call(client.i18n, messages, key, values);
}

/** The English resource read directly, with `{{name}}` filled in as Paseo does. */
function english(key: TextKey, values?: Values): string {
  let node: unknown = en;
  for (const part of key.split(".")) node = (node as Record<string, unknown>)[part];
  if (typeof node !== "string") throw new Error(`Unknown text: ${key}`);
  return node.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => values?.[name] ?? match);
}
