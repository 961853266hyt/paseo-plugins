# Changelog

## 0.2.0

- On Paseo 0.13 and later the plugin follows the app's language, in English or Simplified
  Chinese: the `/btw` command and its Command Center item, the Side questions panel, pill and
  question box, the settings, and the plugin's description and listing page. Earlier Paseo
  versions show English as before.

## 0.1.1

- Added screenshots of the desktop panel and the phone sheet to the plugin listing and the npm
  page.

## 0.1.0

First release.

- `/btw <question>` asks about an agent's conversation without interrupting it, even mid-turn,
  and nothing is added to the agent's history. The question and answer run through the Claude
  Code CLI on the daemon host, with no tools, MCP servers, hooks, CLAUDE.md or saved session.
- The side question sees the conversation's messages first, then tool output and thinking,
  newest first, within about 100,000 characters, and the 20 newest earlier answers. As in Claude
  Code, it says when the answer is not in the conversation, and answers that write tool calls as
  text or are cut off say so.
- The web and desktop app stream the answer into a Side questions panel in the Explorer sidebar,
  with a box for the next question. A pill above the message box follows the answer on every
  layout and opens the thread, with its own question box, in a popover or bottom sheet; it is
  how the mobile apps and narrow windows show it. `/btw` alone reopens the latest side question.
- Copy, Stop and Clear earlier; Markdown answers; at most three side questions run at once.
- A Model setting: the agent's own model by default, Latest Sonnet for non-Claude agents, or any
  Claude model for every agent.
