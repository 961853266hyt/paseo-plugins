import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { textNow } from "./client/i18n";
import { installImageMarkup } from "./client/markup";

export default function contribute(client: PluginClientContext) {
  // The editor draws on an HTML canvas over the app's web DOM: web and desktop only.
  if (Platform.OS !== "web" || typeof document === "undefined") return () => {};

  return installImageMarkup(document, (key, values) => textNow(client, key, values));
}
