Prompt suggestions predicts the message you are likely to send next when an agent finishes a turn, and puts it one keystroke away.

On web and desktop the suggestion appears as the greyed-out placeholder of the agent's message box. Press Tab in the empty box to fill it in, then edit it or press Enter to send. Typing anything else dismisses it, and it disappears as soon as the agent starts its next turn. Where there is no Tab key, in the iOS and Android apps and on phone-sized web (a mobile browser or the installed web app), the suggestion appears instead as a small card below the agent's last reply, with Send and Copy buttons.

Suggestions start from the second exchange of a conversation and only follow turns that completed. Subagents get none.

## Setup

Requires Paseo 0.11.2 or later and the Claude Code CLI (`claude`) installed and signed in on the daemon host. Every prediction runs on Claude Haiku through that CLI by default, whichever agent you are talking to.

## Settings

Under Settings → Plugins → Prompt suggestions, shared by every client of the host:

- **Agent providers**: the providers whose agents get suggestions, such as `claude`, `codex` or `opencode`, separated by commas. Empty, the default, means every agent. Set it to `claude` to keep conversations with other agents from being sent to Anthropic.
- **Model**: what the CLI runs each prediction on, as passed to `claude --model`: an alias such as `haiku` (the default) or `sonnet`, or a full model name.

Saved changes apply from the next prediction, without reloading the plugin.

## What it sends and where

After each completed turn, the plugin takes the most recent part of the conversation (user and agent messages, plus one line per tool call with its name and status, about 6,000 characters at most) and passes it to `claude -p` on the daemon host, which sends it to Anthropic. Unless you limit the agent providers in the settings, this applies to every agent: with Codex, OpenCode or any other non-Claude agent, that part of the conversation still goes to Anthropic to make the prediction. The run has no tools, no MCP servers, no hooks and no saved session, so it cannot act on your project and does not appear in your Claude Code history. It also loads none of your Claude Code settings, so your personal `~/.claude/CLAUDE.md` is not sent along. It counts toward your Claude usage like any other request. Suggestions arrive two to five seconds after a turn ends.

At most two predictions run at once across all agents; the rest wait their turn. A prediction that cannot start within 15 seconds is skipped, and one still waiting when the agent starts its next turn never runs.

## Limits

The web and desktop placeholder relies on how the Paseo app currently renders its message box, not on a plugin API. If a Paseo update changes that, the plugin falls back to the card instead of the placeholder. Suggestions are kept in the daemon's memory and are gone after a daemon restart. So far the plugin has been tested with Claude Code agents only.
