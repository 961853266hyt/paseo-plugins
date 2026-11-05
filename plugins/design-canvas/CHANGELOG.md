# Changelog

## 0.3.0

- Hovering a tweak shows what it drives: every element it reaches is outlined on all artboards,
  the rest fades, a tag names the CSS property, and each artboard's label counts its elements.
  Each tweak says how many elements on how many artboards it reaches (from the pages' own CSS,
  shorthands and variables built from other variables included). Hovering an element on an
  artboard lights up the tweaks that drive it.
- The design picker is a menu in Paseo's style. Hovering a design shows rename and delete, both
  done in the row: renaming edits the title in design.json, deleting asks in the row and moves the
  folder to design/.trash/, from where it can be moved back.
- The plugin page shows a 30-second demo video instead of three screenshots, and the overviews
  no longer repeat the screenshots the page already shows.

## 0.2.0

- **Move** (V) selects and drags named elements, with arrow-key nudges, and drags artboards by
  their title. Element moves are written to the element's inline style by its data-dc-id, and an
  artboard's position to design.json; Ctrl/Cmd+Z undoes and Ctrl/Cmd+Shift+Z redoes.
- **Hand** (H) pans anywhere, over the artboards too. **Browse** is now **Preview** (P).
- A move is refused, and the page reloaded, when the agent changed the page in the meantime.
- Double-click text in Move (or press Enter on a selection) to edit it in place. Only the changed
  characters are written back, so entities and whitespace around them stay; the edit is refused
  when the page's source doesn't have the text the canvas shows. Undo and redo cover it.
- **Tweaks**: agents declare controls in design.json (color, range, toggle, select), each driving
  a CSS variable. The Tweaks panel changes every artboard live and saves the values to tweaks.json
  and tweaks.css. Reset goes back to the defaults; Write into design and Ask the agent for tweaks
  hand the rest to the agent. New tool `design_set_tweaks`,
  and `design_read` lists the values.
- `design/README.md` is updated when it is an older copy of the guide.
- A local stylesheet that doesn't exist yet no longer shows a policy error, and the page reloads
  once the file appears.

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
