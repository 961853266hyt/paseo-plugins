import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Like Claude Code, a thread replays its newest 20 answered side questions with each new one. */
export const MAX_REPLAYED_EXCHANGES = 20;
export const MAX_QUESTION_CHARS = 20_000;
export const USAGE = "Usage: /btw <your question>";

export const exchangeStatusSchema = z.enum(["answering", "answered", "failed", "stopped"]);
export type ExchangeStatus = z.infer<typeof exchangeStatusSchema>;

export const exchangeSummarySchema = z.object({
  id: z.string(),
  question: z.string(),
  status: exchangeStatusSchema,
});
export type ExchangeSummary = z.infer<typeof exchangeSummarySchema>;

export const exchangeSchema = exchangeSummarySchema.extend({
  /** Markdown. Grows while answering; a stopped exchange keeps what arrived. */
  answer: z.string(),
  /** Why there is no answer. Set only when failed. */
  error: z.string().nullable(),
  /** The model that answered, as Claude Code reports it, or the one requested until it does. */
  model: z.string().nullable(),
  askedAt: z.number(),
});
export type Exchange = z.infer<typeof exchangeSchema>;

export const threadSchema = z.object({
  /** Oldest first; the last one is the current side question. */
  exchanges: z.array(exchangeSummarySchema),
  /** The requested exchange, else the newest; null when the thread is empty. */
  focus: exchangeSchema.nullable(),
});
export type Thread = z.infer<typeof threadSchema>;

const agentInput = z.object({ agentId: z.string().min(1) });

export const askSideQuestion = defineRpc({
  name: "ask_side_question",
  input: agentInput.extend({ question: z.string() }),
  output: z.object({ exchangeId: z.string() }),
});

export const getThread = defineRpc({
  name: "get_thread",
  input: agentInput.extend({ focusId: z.string().nullable() }),
  output: threadSchema,
});

export const stopSideQuestion = defineRpc({
  name: "stop_side_question",
  input: agentInput.extend({ exchangeId: z.string() }),
  output: z.object({}),
});

/** Like Claude Code's `x`: forgets the earlier side questions, keeping the current one. */
export const clearSideQuestions = defineRpc({
  name: "clear_side_questions",
  input: agentInput,
  output: z.object({}),
});
