# Changelog

## 0.1.0

First release.

- After each completed agent turn from the second exchange on, predicts your next message with
  Claude Haiku through the Claude Code CLI on the daemon host.
- Web and desktop: shows the suggestion as the message box placeholder; Tab in the empty box
  accepts it, typing dismisses it.
- iOS, Android and phone-sized web: shows a card below the last reply with Send and Copy.
- The suggestion disappears when the agent's next turn starts, or when it is closed or archived.
- Logs every outcome, including the model's reply when no suggestion is shown, to the plugin log.
