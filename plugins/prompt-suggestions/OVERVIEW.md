Prompt suggestions predicts the message you are likely to send next when an agent finishes a turn, and puts it one keystroke away.

On web and desktop the suggestion appears as the greyed-out placeholder of the agent's message box. Press Tab in the empty box to fill it in, then edit it or press Enter to send. Typing anything else dismisses it, and it disappears as soon as the agent starts its next turn. Where there is no Tab key, in the iOS and Android apps and on phone-sized web (a mobile browser or the installed web app), the suggestion appears instead as a small card below the agent's last reply, with Send and Copy buttons.

Suggestions start from the second exchange of a conversation and only follow turns that completed. Subagents get none.

## Setup

Requires Paseo 0.11.2 or later and the Claude Code CLI (`claude`) installed and signed in on the daemon host. Every prediction runs on Claude Haiku through that CLI, whichever agent you are talking to.

## What it sends and where

After each completed turn, the plugin takes the most recent part of the conversation (user and agent messages, plus one line per tool call with its name and status, about 6,000 characters at most) and passes it to `claude -p` on the daemon host, which sends it to Anthropic. This applies to every agent: with Codex, OpenCode or any other non-Claude agent, that part of the conversation still goes to Anthropic to make the prediction. The run has no tools, no MCP servers, no hooks and no saved session, so it cannot act on your project and does not appear in your Claude Code history. It counts toward your Claude usage like any other request. Suggestions arrive two to five seconds after a turn ends.

## Limits

The web and desktop placeholder relies on how the Paseo app currently renders its message box, not on a plugin API. If a Paseo update changes that, the plugin falls back to the card instead of the placeholder. Suggestions are kept in the daemon's memory and are gone after a daemon restart. So far the plugin has been tested with Claude Code agents only.
