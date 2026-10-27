<!-- npm shows this file; the Paseo registry shows OVERVIEW.md. The sections after Install repeat
OVERVIEW.md, so change both together. -->

# Prompt suggestions for Paseo

A [Paseo](https://paseo.sh) plugin that predicts the message you are likely to send next when an agent finishes a turn, and puts it one keystroke away.

On web and desktop the suggestion appears as the greyed-out placeholder of the agent's message box. Press Tab in the empty box to fill it in, then edit it or press Enter to send. Typing anything else dismisses it, and it disappears as soon as the agent starts its next turn. Where there is no Tab key, in the iOS and Android apps and on phone-sized web (a mobile browser or the installed web app), the suggestion appears instead as a small card below the agent's last reply, with Send and Copy buttons.

Suggestions start from the second exchange of a conversation and only follow turns that completed. Subagents get none.

![The suggestion as the message box placeholder on desktop](https://raw.githubusercontent.com/961853266hyt/paseo-plugins/main/plugins/prompt-suggestions/assets/desktop-placeholder.png)

![The suggestion as a card on a phone](https://raw.githubusercontent.com/961853266hyt/paseo-plugins/main/plugins/prompt-suggestions/assets/phone-card.png)

## Install

From the [Paseo plugin registry](https://paseo.sh/plugins), which installs the reviewed version:

```bash
paseo plugin add 961853266hyt/prompt-suggestions
```

Or this npm package directly:

```bash
paseo plugin install npm:paseo-prompt-suggestions
```

Update it later with `paseo plugin update prompt-suggestions`. Plugins are trusted code: the server part runs on the daemon host and the client part runs inside the Paseo app.

## Requirements

Requires Paseo 0.11.2 or later and the Claude Code CLI (`claude`) installed and signed in on the daemon host. Every prediction runs on Claude Haiku through that CLI by default, whichever agent you are talking to.

On Paseo 0.13 or later the plugin shows its text in the app's language, English or Simplified Chinese; earlier versions show English.

## Settings

In Settings → Plugins, open the ⋯ menu of Prompt suggestions and choose Settings. The settings are shared by every client of the host:

- **Suggest for**: All agents, the default, or Claude agents only. Choose Claude agents only to keep conversations with Codex, OpenCode and other agents from being sent to Anthropic.
- **Model**: Latest Haiku (the default), Latest Sonnet or Latest Opus, which follow the newest model of each family, or a specific Claude model from the list Paseo offers for Claude agents. Larger models predict more slowly and use more of your Claude usage.

A change is saved as soon as you choose it and applies from the next prediction, without reloading the plugin.

## What it sends and where

After each completed turn, the plugin takes the most recent part of the conversation (user and agent messages, plus one line per tool call with its name and status, about 6,000 characters at most) and passes it to `claude -p` on the daemon host, which sends it to Anthropic. Unless you choose Claude agents only in the settings, this applies to every agent: with Codex, OpenCode or any other non-Claude agent, that part of the conversation still goes to Anthropic to make the prediction. The run has no tools, no MCP servers, no hooks and no saved session, so it cannot act on your project and does not appear in your Claude Code history. It also loads none of your CLAUDE.md, rules or memory files, so your personal `~/.claude/CLAUDE.md` is not sent along. Your Claude Code settings still apply, so a gateway, proxy, Bedrock or Vertex setup or `apiKeyHelper` you configured there is used as usual. It counts toward your Claude usage like any other request. Suggestions arrive two to five seconds after a turn ends.

At most two predictions run at once across all agents; the rest wait their turn. A prediction that cannot start within 15 seconds is skipped, and one still waiting when the agent starts its next turn never runs.

## Limits

The web and desktop placeholder relies on how the Paseo app currently renders its message box, not on a plugin API. If a Paseo update changes that, the plugin falls back to the card instead of the placeholder. Suggestions are kept in the daemon's memory and are gone after a daemon restart. So far the plugin has been tested with Claude Code agents only.

## Changes and license

See the [changelog](https://github.com/961853266hyt/paseo-plugins/blob/main/plugins/prompt-suggestions/CHANGELOG.md). Source: [961853266hyt/paseo-plugins](https://github.com/961853266hyt/paseo-plugins/tree/main/plugins/prompt-suggestions). MIT license.
