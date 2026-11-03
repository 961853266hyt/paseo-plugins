import { defineTranslations, type PluginText } from "@getpaseo/plugin/client";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

export type TextKey = keyof typeof en;

export const messages = defineTranslations({ resources: { en, "zh-CN": zhCN } });

/** A label Paseo renders, such as a panel or Command Center title. It follows the app's language. */
export function label(key: TextKey): PluginText {
  return messages.message(key);
}
