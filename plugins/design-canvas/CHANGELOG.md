# Changelog

## 0.1.1

- The overviews now say how a design's own code can still reach the network (by navigating its
  frame, or with markup before `<head>`), ask you to open only designs you trust, and describe
  more precisely which paths the plugin refuses.

## 0.1.0

First release.

- A **Design** tab for each agent shows a workspace's designs as HTML artboards, side by side,
  with zoom, pan, fit and a layout grid. It reloads an artboard when the agent changes its files.
- **Comment** mode picks an element and pins a numbered comment to it; **Send to the agent** hands
  every waiting comment over in one message, and the agent marks them resolved with a note.
- Start a design from the empty canvas, from `/canvas <brief>` in the chat, or open the canvas from
  the Command Center.
- Agents get `design_create`, `design_list`, `design_read` and `design_resolve_comments`.
- Web and desktop app, Paseo 0.14 or later, in English or Simplified Chinese.
