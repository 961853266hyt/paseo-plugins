import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_MODEL = "haiku";

/** Host-wide settings, edited under Settings → Plugins and read live by the daemon. */
export const suggestionSettings = defineSettings({
  id: "suggestions",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Agent providers that get suggestions, such as `claude` or `codex`; empty means every one. */
    providers: z.array(z.string().trim().min(1)).default([]),
    /** Passed to `claude --model`; a leading dash would read as a flag. */
    model: z
      .string()
      .trim()
      .regex(/^[^\s-]\S*$/, "Enter a model such as haiku")
      .default(DEFAULT_MODEL),
  }),
});

export type SuggestionSettings = z.output<typeof suggestionSettings.schema>;

export function suggestsFor(settings: SuggestionSettings, provider: string): boolean {
  return settings.providers.length === 0 || settings.providers.includes(provider);
}

/** "claude, codex" or "claude codex" as typed in the settings screen. */
export function parseProviders(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter((provider) => provider.length > 0))];
}
