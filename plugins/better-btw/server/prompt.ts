import { MAX_REPLAYED_EXCHANGES } from "../shared/thread";
import { clip } from "./transcript";

const MAX_REPLAYED_ANSWER_CHARS = 6_000;
const MAX_REPLAY_CHARS = 30_000;

/**
 * The rules Claude Code gives its side questions. There the conversation is the model's own; here
 * it arrives as a transcript, so the model is told to answer as the agent, as Claude Code's does.
 */
export const SYSTEM_PROMPT = `You are an AI coding agent answering a quick side question from the developer you are working with. They asked it with /btw while you keep working on the main task, so this is a separate, one-off reply: it is shown to them once and never enters the main conversation.

The main conversation so far comes first. [User] is the developer and [Assistant] is you; [Thinking] is your own reasoning, and each [Tool: name] entry is a tool call you made, followed by its output where there was room. Earlier side questions and your answers to them may follow it.

- Answer only from the conversation and the earlier side questions. You have no tools here: you cannot read files, run commands, search, or take any action.
- Never write tool calls or tool output as text, and never announce an action such as "Let me check". Nothing you write here is executed.
- If the answer needs something the conversation does not show, say that you cannot check it from a side question and suggest asking in the main conversation. Do not guess.
- Speak as yourself, the agent, in the first person, and do not invent reasons the conversation does not give.
- You were not interrupted, so do not mention an interruption or what you were doing before the question.
- Reply once; there is no follow-up turn. Be direct and brief, write in the language the side question is written in, and use Markdown only where it helps, such as for code.`;

export const TOOLS_NOTE =
  "_Side questions can't run tools. Any tool calls or output shown above were not executed and may not match your files. Ask the agent to check._";
export const CUT_OFF_NOTE = "_This answer was cut off before it finished. Ask again to retry._";
const TOOLS_REPLAYED = "(That answer wrote tool calls as text. Nothing was executed, so it is left out here.)";
const CUT_OFF_REPLAYED = "(That answer was cut off before it finished, so it is left out here.)";

/** Tool-call markup a model sometimes writes as plain text, with or without a namespace prefix. */
const TOOL_CALL_TEXT = /<(?:\w+:)?(?:function_calls>|invoke name=)|<\/(?:\w+:)?(?:function_calls|invoke)>/;

export function writesToolCalls(text: string): boolean {
  return TOOL_CALL_TEXT.test(text);
}

export function toolAttemptNotice(tool: string): string {
  return `(The model tried to use the ${tool} tool instead of answering. Rephrase the question, or ask the agent directly.)`;
}

export interface ReplayedExchange {
  question: string;
  answer: string;
}

export interface PromptInput {
  transcript: string;
  /** Mid-turn, so the transcript's last entries may be incomplete. */
  agentRunning: boolean;
  /** Earlier answered side questions, oldest first. */
  earlier: readonly ReplayedExchange[];
  question: string;
}

/** Sent on stdin: a long transcript would overflow a single command-line argument. */
export function buildPrompt(input: PromptInput): string {
  const conversation = input.transcript || "(The conversation is empty so far.)";
  const parts = [`<conversation>\n${conversation}\n</conversation>`];
  if (input.agentRunning) {
    parts.push("You are still working on the main task, so your latest message or tool call may be incomplete.");
  }
  const earlier = replay(input.earlier);
  if (earlier) parts.push(`<earlier_side_questions>\n${earlier}\n</earlier_side_questions>`);
  parts.push(
    `Answer this side question in one reply, in the language it is written in, from what is above and without tools:\n<side_question>\n${input.question}\n</side_question>`,
  );
  return parts.join("\n\n");
}

/** The newest exchanges that fit, oldest first, with answers that would mislead swapped for a note. */
function replay(exchanges: readonly ReplayedExchange[]): string {
  const blocks: string[] = [];
  let used = 0;
  for (const exchange of exchanges.slice(-MAX_REPLAYED_EXCHANGES).reverse()) {
    const block = `<question>\n${exchange.question}\n</question>\n<answer>\n${replayedAnswer(exchange.answer)}\n</answer>`;
    if (used + block.length > MAX_REPLAY_CHARS) break;
    blocks.unshift(block);
    used += block.length + 1;
  }
  return blocks.join("\n");
}

function replayedAnswer(answer: string): string {
  if (writesToolCalls(answer)) return TOOLS_REPLAYED;
  if (answer.endsWith(CUT_OFF_NOTE)) return CUT_OFF_REPLAYED;
  return clip(answer, MAX_REPLAYED_ANSWER_CHARS);
}
