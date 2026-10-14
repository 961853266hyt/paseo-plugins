# Changelog

## 0.2.0

- Added settings under Settings → Plugins → Prompt suggestions: which agent providers get
  suggestions, and the model each prediction runs on. The defaults, every provider and Haiku,
  keep the earlier behaviour. Changes apply without reloading the plugin.
- Predictions no longer load your Claude Code user, project or local settings, so your personal
  `~/.claude/CLAUDE.md` stays out of them and they use fewer input tokens.
- At most two predictions run at once across all agents; the rest wait their turn within the
  same time limit and are dropped when the agent's next turn starts first.

## 0.1.0

First release.

- After each completed agent turn from the second exchange on, predicts your next message with
  Claude Haiku through the Claude Code CLI on the daemon host.
- Web and desktop: shows the suggestion as the message box placeholder; Tab in the empty box
  accepts it, typing dismisses it.
- iOS, Android and phone-sized web: shows a card below the last reply with Send and Copy.
- The suggestion disappears when the agent's next turn starts, or when it is closed or archived.
- Logs every outcome, including the model's reply when no suggestion is shown, to the plugin log.
