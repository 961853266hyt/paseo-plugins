import * as sdk from "@getpaseo/plugin/client";
import type {
  PluginClientContext,
  PluginMessage,
  PluginText,
  PluginTranslations,
} from "@getpaseo/plugin/client";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

type Resource = typeof en;
export type TextKey = Parameters<PluginTranslations<Resource>["message"]>[0];
type Values = Readonly<Record<string, string>>;
type Translate = (key: TextKey, values?: Values) => string;

/**
 * Paseo 0.13 added plugin translations. Older apps supply none of these exports, so the plugin
 * shows its English text there instead.
 */
const messages: PluginTranslations<Resource> | null =
  typeof sdk.defineTranslations === "function"
    ? sdk.defineTranslations({ resources: { en, "zh-CN": zhCN } })
    : null;

/** A label Paseo renders, such as a screen title. It follows the app's language as that changes. */
export function label(key: TextKey, values?: Values): PluginText {
  if (!messages) return english(key, values);
  const message = messages.message as (key: TextKey, values?: Values) => PluginMessage;
  return message(key, values);
}

/** Text for a callback, in the app's language at the moment it runs. */
export function textNow(client: PluginClientContext, key: TextKey, values?: Values): string {
  if (!messages || !client.i18n) return english(key, values);
  const t = client.i18n.t as (
    messages: PluginTranslations<Resource>,
    key: TextKey,
    values?: Values,
  ) => string;
  return t.call(client.i18n, messages, key, values);
}

/** Text for the plugin's own components, which render again when the app's language changes. */
export const useText: () => Translate =
  messages && typeof sdk.useTranslation === "function" ? useTranslated : () => english;

function useTranslated(): Translate {
  return sdk.useTranslation(messages!).t as Translate;
}

/** The English resource read directly, with `{{name}}` filled in as Paseo does. */
function english(key: TextKey, values?: Values): string {
  let node: unknown = en;
  for (const part of key.split(".")) node = (node as Record<string, unknown>)[part];
  if (typeof node !== "string") throw new Error(`Unknown text: ${key}`);
  return node.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => values?.[name] ?? match);
}
