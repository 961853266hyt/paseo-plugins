import { z } from "zod";

/** Timeline row kind and contract version shared by the daemon writer and the app renderer. */
export const SUGGESTION_ROW_KIND = "prompt-suggestion";
export const SUGGESTION_ROW_VERSION = 1;

/**
 * A row is written `ready` when a turn ends and rewritten `dismissed` when the next turn opens.
 * Rewriting the same row id keeps it at its original position in the timeline.
 */
export const suggestionRowSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), text: z.string().min(1) }),
  z.object({ status: z.literal("dismissed") }),
]);

export type SuggestionRow = z.infer<typeof suggestionRowSchema>;
