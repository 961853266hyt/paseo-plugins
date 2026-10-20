Better btw brings Claude Code's `/btw` to Paseo: ask a quick question about what an agent is doing without interrupting it, and without adding anything to its conversation.

Type `/btw` and a question in an agent's message box, such as `/btw what was the name of that config file again?`. Paseo runs the command in the app and never sends it to the agent, so it works while the agent is busy and leaves the running turn alone. In the web and desktop app the answer streams into a Side questions panel in the Explorer sidebar, beside the chat, with a box for the next question. A pill above the message box also follows the answer, and it is how the iOS and Android apps and narrow windows show it: the pill reports the answer's progress, and a tap opens the thread, with its own question box, in a popover or bottom sheet. `/btw` on its own brings the latest side question back, and the Command Center item Side questions (/btw) opens the panel.

As in Claude Code:

- A side question sees the conversation so far: your messages, the agent's replies and thinking, and its tool calls with their output, including a turn that is still running. It has no tools, so it cannot read files, run commands or search, and when the answer is not in the conversation it says so instead of guessing.
- Each answer is a single reply. A later side question also sees the earlier ones: the 20 newest answers are replayed with each new question.
- The thread stays out of the agent's history. Copy takes an answer as Markdown, Clear earlier forgets all but the current side question, and Stop ends an answer that is still arriving. Answers render as Markdown.

## Setup

Requires Paseo 0.11.2 or later and the Claude Code CLI (`claude`) installed and signed in on the daemon host. Side questions run through that CLI whichever agent you ask about.

## Settings

In Settings → Plugins, open the ⋯ menu of Better btw and choose Settings. The setting is shared by every client of the host:

- **Model**: Same as the agent, the default, answers with a Claude agent's own model, as Claude Code does, and with Latest Sonnet for Codex, OpenCode and other agents. Latest Haiku, Latest Sonnet, Latest Opus or a specific Claude model from the list Paseo offers for Claude agents applies to every agent. Haiku answers fastest; larger models use more of your Claude usage.

A change applies from the next side question, without reloading the plugin.

## What it sends and where

When you ask, the plugin reads the agent's conversation from the daemon and builds a transcript of about 100,000 characters at most: user and agent messages across the whole session first, then tool output and the agent's thinking, newest first. A longer session keeps its first request and its newest history. The transcript, your earlier side questions with their answers, and the new question go to `claude -p` on the daemon host, which sends them to Anthropic. This applies to every agent: with Codex, OpenCode or any other non-Claude agent, the conversation still goes to Anthropic.

The run has no tools, no MCP servers, no hooks and no saved session, so it cannot act on your project and does not appear in your Claude Code history. It also loads none of your CLAUDE.md, rules or memory files. Your Claude Code settings still apply, so a gateway, proxy, Bedrock or Vertex setup or `apiKeyHelper` you configured there is used as usual. Each side question counts toward your Claude usage like any other request. Claude Code's own `/btw` reuses the conversation's prompt cache; a plugin cannot, so every side question pays for the transcript it reads.

At most three side questions run at once across all agents, and the rest wait up to a minute for a turn. An answer still running after three minutes is stopped.

## Limits

- Plugins cannot open an overlay on their own, so where no panel opens beside the chat, in the iOS and Android apps and in narrow windows, the answer is one tap away in the pill rather than on screen.
- An answer streams in small steps rather than token by token: while it arrives, the app asks the daemon for it every 0.4 seconds.
- Side threads live in the daemon's memory: a daemon restart or plugin reload clears them, and archiving an agent drops its thread.
- A side question sees what Paseo's timeline recorded of the conversation.
- `/btw` does not run when the message box has an attachment: Paseo then sends the text to the agent as a normal message.
