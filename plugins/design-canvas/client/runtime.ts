import { PROTOCOL_MARK } from "../shared/runtime-protocol";
import { COMMENT_CURSOR } from "./cursors";

/**
 * Runs inside every artboard's iframe. Plain JavaScript in a string, not a compiled function: a
 * bundler's helpers (such as esbuild's __name) would not exist inside the iframe.
 *
 * It draws hover and selection boxes, numbered comment pins and layout guides in a shadow root,
 * reports picked elements, moves elements and edits text in the Move tool, applies tweak values,
 * forwards zoom and pan gestures, and reports the page height. It only ever talks to its parent window.
 */
export const RUNTIME_SOURCE = String.raw`(function () {
  "use strict";
  var MARK = ${JSON.stringify(PROTOCOL_MARK)};
  var COMMENT_CURSOR = ${JSON.stringify(COMMENT_CURSOR)};
  var mode = "preview";
  var pins = [];
  var selectedId = null;
  var guides = false;
  var scale = 1;
  var hovered = null;
  var picked = null;
  var host = null;
  var layer = null;
  var hoverBox = null;
  var pickBox = null;
  var grid = null;
  var selBox = null;
  // The Move tool's selection and the drag in progress
  var selected = null;
  var drag = null;
  // The text being edited: { span, before, target }
  var editing = null;
  var frameQueued = false;
  var lastHeight = -1;
  var COLORS = { pending: "#d97757", sent: "#3b82f6", resolved: "#16a34a" };
  var PX = /^-?\d+(?:\.\d+)?px$/;

  function post(message) {
    message.mark = MARK;
    try { window.parent.postMessage(message, "*"); } catch (e) {}
  }

  function pageHeight() {
    var d = document.documentElement;
    var b = document.body;
    return Math.max(d ? d.scrollHeight : 0, b ? b.scrollHeight : 0, d ? d.offsetHeight : 0);
  }

  function reportSize() {
    var height = pageHeight();
    if (Math.abs(height - lastHeight) < 1) return;
    lastHeight = height;
    post({ type: "size", height: height });
  }

  function isOurs(el) {
    return el === host || (host && host.contains(el));
  }

  function pageRect(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
  }

  function viewRect(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  function cssPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      if (node.id && document.querySelectorAll("#" + CSS.escape(node.id)).length === 1) {
        parts.unshift("#" + CSS.escape(node.id));
        return parts.join(" > ");
      }
      var tag = node.tagName.toLowerCase();
      var index = 1;
      var sibling = node.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === node.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(tag + ":nth-of-type(" + index + ")");
      node = node.parentElement;
    }
    parts.unshift("body");
    return parts.join(" > ");
  }

  function clip(text, max) {
    var flat = String(text || "").replace(/\s+/g, " ").trim();
    return flat.length > max ? flat.slice(0, max) : flat;
  }

  /** Snaps to the nearest element the agent named with data-dc-id, unless Alt picks the exact one. */
  function target(el, exact) {
    if (!el || el.nodeType !== 1 || isOurs(el)) return null;
    if (el === document.documentElement) return null;
    if (!exact && el.closest) {
      var named = el.closest("[data-dc-id]");
      if (named && named !== document.documentElement) return named;
    }
    return el;
  }

  /** The Move tool only moves elements the agent named, since a move is written back by data-dc-id. */
  function movable(el) {
    if (!el || el.nodeType !== 1 || isOurs(el) || !el.closest) return null;
    var named = el.closest("[data-dc-id]");
    return named && named !== document.documentElement && named !== document.body ? named : null;
  }

  function positioned(el) {
    var position = getComputedStyle(el).position;
    return position === "absolute" || position === "fixed";
  }

  /** Where the element sits now: left/top for positioned elements, translate for the rest. */
  function baseOf(el) {
    var cs = getComputedStyle(el);
    if (positioned(el)) {
      var left = parseFloat(cs.left), top = parseFloat(cs.top);
      return { kind: "position", x: isNaN(left) ? el.offsetLeft : left, y: isNaN(top) ? el.offsetTop : top };
    }
    var value = cs.translate && cs.translate !== "none" ? cs.translate.split(/\s+/) : [];
    if (value.some(function (part) { return part.indexOf("%") >= 0; })) return null;
    return { kind: "translate", x: parseFloat(value[0] || "0") || 0, y: parseFloat(value[1] || "0") || 0 };
  }

  function styleFor(base, dx, dy) {
    var x = Math.round(base.x + dx), y = Math.round(base.y + dy);
    return base.kind === "position" ? { left: x + "px", top: y + "px" } : { translate: x + "px " + y + "px" };
  }

  /** The element's own inline values for the properties a move writes, for undo. */
  function inlineOf(el, keys) {
    var out = {};
    keys.forEach(function (key) {
      var value = el.style[key] || "";
      if (key === "translate" && value) {
        var parts = value.split(/\s+/);
        value = PX.test(parts[0]) && (!parts[1] || PX.test(parts[1])) ? parts[0] + " " + (parts[1] || "0px") : "";
      } else if (value && !PX.test(value)) value = "";
      out[key] = value;
    });
    return out;
  }

  function applyStyle(el, style) {
    Object.keys(style).forEach(function (key) { el.style[key] = style[key]; });
  }

  function reportMove(el, before, after) {
    post({ type: "moved", dcId: el.getAttribute("data-dc-id"), before: before, after: after });
  }

  // ---- Text editing ----

  /** How the canvas finds a text node in the page's source; see textTargetSchema. */
  function locateText(node) {
    var el = node.parentNode;
    if (!el || el.nodeType !== 1 || !document.body || !document.body.contains(el)) return null;
    var index = 0;
    for (var c = el.firstChild; c && c !== node; c = c.nextSibling) if (c.nodeType === 3) index++;
    var path = [];
    var cur = el;
    while (cur !== document.body) {
      var id = cur.getAttribute("data-dc-id");
      if (id && id.length <= 120 && document.querySelectorAll('[data-dc-id="' + CSS.escape(id) + '"]').length === 1) {
        return { dcId: id, path: path, index: index };
      }
      var parent = cur.parentElement;
      if (!parent || path.length >= 64) return null;
      path.unshift(Array.prototype.indexOf.call(parent.children, cur));
      cur = parent;
    }
    return { path: path, index: index };
  }

  function findText(target) {
    var el = null;
    try {
      el = target.dcId ? document.querySelector('[data-dc-id="' + CSS.escape(target.dcId) + '"]') : document.body;
    } catch (e) { return null; }
    for (var i = 0; el && i < target.path.length; i++) el = el.children[target.path[i]];
    if (!el) return null;
    var n = 0;
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 3) continue;
      if (n === target.index) return c;
      n++;
    }
    return null;
  }

  function directTexts(el) {
    var out = [];
    for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3 && /\S/.test(c.data)) out.push(c);
    return out;
  }

  function hitsText(node, x, y) {
    var range = document.createRange();
    range.selectNodeContents(node);
    var rects = range.getClientRects();
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) return true;
    }
    return false;
  }

  /** The text node under the pointer, else the one run of text of the element (or a parent) there. */
  function textAt(event) {
    var node = null;
    if (document.caretPositionFromPoint) {
      var position = document.caretPositionFromPoint(event.clientX, event.clientY);
      if (position) node = position.offsetNode;
    } else if (document.caretRangeFromPoint) {
      var range = document.caretRangeFromPoint(event.clientX, event.clientY);
      if (range) node = range.startContainer;
    }
    if (node && node.nodeType === 3 && /\S/.test(node.data) && hitsText(node, event.clientX, event.clientY)) return node;
    for (var el = event.target; el && el.nodeType === 1 && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      var texts = directTexts(el);
      if (texts.length === 1) return texts[0];
      if (texts.length > 1) break;
    }
    return null;
  }

  function firstText(el) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      if (/\S/.test(node.data) && editableText(node) === true) return node;
    }
    return null;
  }

  /** true, or why the text can't be edited in place. */
  function editableText(node) {
    var parent = node.parentNode;
    if (!parent || parent.nodeType !== 1 || isOurs(parent)) return "no-text";
    if (parent.namespaceURI !== "http://www.w3.org/1999/xhtml") return "svg";
    if (parent.closest("script,style,textarea,select,option,title,noscript")) return "no-text";
    return true;
  }

  function startEdit(node) {
    var why = editableText(node);
    if (why !== true) { post({ type: "uneditable", reason: why }); return; }
    var target = locateText(node);
    if (!target) { post({ type: "uneditable", reason: "no-text" }); return; }
    var span = document.createElement("span");
    span.setAttribute("data-dc-editing", "");
    try { span.contentEditable = "plaintext-only"; } catch (e) {}
    if (span.contentEditable !== "plaintext-only") span.contentEditable = "true";
    span.style.cssText = "outline:none;user-select:text;-webkit-user-select:text;";
    span.setAttribute("spellcheck", "false");
    node.parentNode.replaceChild(span, node);
    span.appendChild(node);
    editing = { span: span, before: node.data, target: target };
    selected = null;
    hovered = null;
    span.addEventListener("blur", function () { endEdit(true); });
    span.addEventListener("paste", function (event) {
      event.preventDefault();
      var text = (event.clipboardData && event.clipboardData.getData("text/plain")) || "";
      document.execCommand("insertText", false, text.replace(/\s*[\r\n]+\s*/g, " "));
    });
    span.addEventListener("beforeinput", function (event) {
      if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") event.preventDefault();
    });
    post({ type: "editing", on: true });
    try { window.focus(); } catch (e) {}
    span.focus();
    var selection = window.getSelection();
    if (selection) {
      var all = document.createRange();
      all.selectNodeContents(span);
      selection.removeAllRanges();
      selection.addRange(all);
    }
    schedule();
  }

  function endEdit(commit) {
    var done = editing;
    if (!done) return;
    editing = null;
    var text = commit ? done.span.textContent : done.before;
    // The browser types non-breaking spaces where a plain one would collapse.
    if (commit && done.before.indexOf("\u00a0") < 0) text = text.replace(/\u00a0/g, " ");
    var node = document.createTextNode(text);
    if (done.span.parentNode) done.span.parentNode.replaceChild(node, done.span);
    var selection = window.getSelection();
    if (selection) selection.removeAllRanges();
    post({ type: "editing", on: false });
    if (commit && text !== done.before) post({ type: "text-edited", target: done.target, before: done.before, after: text });
    schedule();
  }

  function inEditor(el) {
    return !!(editing && el && (el === editing.span || editing.span.contains(el)));
  }

  /** Tweak values: custom properties on the root, which beat the page's own :root rules. */
  function applyTweaks(vars) {
    var root = document.documentElement;
    if (!root || !vars) return;
    Object.keys(vars).forEach(function (name) {
      if (!/^--[A-Za-z0-9_-]{1,60}$/.test(name)) return;
      var value = String(vars[name] || "");
      if (value) root.style.setProperty(name, value);
      else root.style.removeProperty(name);
    });
  }

  function describe(el) {
    var info = {
      path: cssPath(el),
      tag: el.tagName.toLowerCase(),
      text: clip(el.innerText || el.textContent, 200),
      html: String(el.outerHTML || "").slice(0, 1200),
      rect: pageRect(el)
    };
    var dcId = el.getAttribute("data-dc-id");
    if (dcId) info.dcId = dcId.slice(0, 120);
    return info;
  }

  function find(pin) {
    var el = null;
    try {
      if (pin.dcId) el = document.querySelector('[data-dc-id="' + CSS.escape(pin.dcId) + '"]');
      if (!el && pin.path) el = document.querySelector(pin.path);
    } catch (e) { el = null; }
    return el;
  }

  function ensureLayer() {
    if (layer || !document.documentElement) return;
    host = document.createElement("design-canvas-overlay");
    host.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
    var root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;
    var style = document.createElement("style");
    style.textContent = [
      ".box{position:absolute;pointer-events:none;border-radius:3px;box-sizing:border-box;display:none}",
      ".hover{border:1.5px solid #d97757;background:rgba(217,119,87,.08)}",
      ".pick{border:2px solid #d97757;background:rgba(217,119,87,.12)}",
      ".hover.move{border-color:#0d99ff;background:transparent}",
      ".sel{border:1.5px solid #0d99ff;border-radius:0}",
      ".sel i{position:absolute;width:8px;height:8px;margin:-4px 0 0 -4px;background:#fff;border:1.5px solid #0d99ff;box-sizing:border-box}",
      ".sel.text{border-radius:2px}.sel.text i{display:none}",
      ".sel i:nth-child(1){left:0;top:0}.sel i:nth-child(2){left:100%;top:0}.sel i:nth-child(3){left:0;top:100%}.sel i:nth-child(4){left:100%;top:100%}",
      ".pin{position:absolute;width:24px;height:24px;margin:-12px 0 0 -12px;border-radius:12px 12px 12px 2px;",
      "color:#fff;font:600 12px/24px system-ui,sans-serif;text-align:center;pointer-events:auto;cursor:pointer;",
      "box-shadow:0 1px 3px rgba(0,0,0,.35);border:1.5px solid #fff;box-sizing:border-box;user-select:none}",
      ".pin.resolved{opacity:.55}",
      ".grid{position:fixed;inset:0;pointer-events:none;display:none;",
      "background-image:linear-gradient(to right,rgba(217,119,87,.18) 1px,transparent 1px),",
      "linear-gradient(to bottom,rgba(217,119,87,.18) 1px,transparent 1px);background-size:8px 8px}"
    ].join("");
    root.appendChild(style);
    grid = document.createElement("div");
    grid.className = "grid";
    hoverBox = document.createElement("div");
    hoverBox.className = "box hover";
    pickBox = document.createElement("div");
    pickBox.className = "box pick";
    selBox = document.createElement("div");
    selBox.className = "box sel";
    for (var h = 0; h < 4; h++) selBox.appendChild(document.createElement("i"));
    layer = document.createElement("div");
    root.appendChild(grid);
    root.appendChild(selBox);
    root.appendChild(hoverBox);
    root.appendChild(pickBox);
    root.appendChild(layer);
    document.documentElement.appendChild(host);
  }

  function place(box, rect, border) {
    if (!rect) { box.style.display = "none"; return; }
    box.style.display = "block";
    box.style.borderWidth = border * scale + "px";
    box.style.left = rect.x + "px";
    box.style.top = rect.y + "px";
    box.style.width = rect.width + "px";
    box.style.height = rect.height + "px";
  }

  function render() {
    frameQueued = false;
    ensureLayer();
    if (!layer) return;
    grid.style.display = guides ? "block" : "none";
    var hovering = (mode === "comment" || mode === "move") && hovered && hovered.isConnected && hovered !== selected && !drag && !editing;
    hoverBox.className = "box hover" + (mode === "move" ? " move" : "");
    place(hoverBox, hovering ? pageRect(hovered) : null, 1.5);
    place(pickBox, picked && picked.isConnected ? pageRect(picked) : null, 2);
    var boxed = editing ? editing.span : mode === "move" && selected && selected.isConnected ? selected : null;
    selBox.className = "box sel" + (editing ? " text" : "");
    place(selBox, boxed ? pageRect(boxed) : null, 1.5);
    for (var c = 0; c < selBox.children.length; c++) selBox.children[c].style.transform = "scale(" + scale + ")";
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    // The visible width: a spinning or overflowing element must not push pins off the artboard
    var maxX = document.documentElement.clientWidth || window.innerWidth;
    pins.forEach(function (pin) {
      var el = find(pin);
      var rect = el ? pageRect(el) : pin.rect;
      var dot = document.createElement("div");
      dot.className = "pin" + (pin.id === selectedId ? " selected" : "") + (pin.status === "resolved" ? " resolved" : "");
      dot.style.background = COLORS[pin.status] || COLORS.pending;
      dot.style.transform = "scale(" + scale * (pin.id === selectedId ? 1.25 : 1) + ")";
      var inset = 14 * scale;
      dot.style.left = Math.min(Math.max(rect.x + rect.width, inset), maxX - inset) + "px";
      dot.style.top = Math.max(rect.y, inset) + "px";
      dot.textContent = String(pin.number);
      dot.title = "#" + pin.number;
      dot.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        post({ type: "pin", id: pin.id, viewport: viewRect(dot) });
      });
      layer.appendChild(dot);
    });
    reportSize();
  }

  /**
   * The tool's cursor over the whole page, the page's own cursors included: a comment bubble in
   * Comment, a plain arrow in Move (the page's buttons do nothing there). Preview keeps the page's.
   */
  function showToolCursor() {
    var html = document.documentElement;
    if (!html) return;
    if (!document.querySelector("style[data-dc-cursor]")) {
      var style = document.createElement("style");
      style.setAttribute("data-dc-cursor", "");
      style.textContent = 'html[data-dc-tool="comment"], html[data-dc-tool="comment"] * { cursor: ' + COMMENT_CURSOR + ' !important; }' +
        'html[data-dc-tool="move"], html[data-dc-tool="move"] * { cursor: default !important; }' +
        'html[data-dc-tool] [data-dc-editing], html[data-dc-tool] [data-dc-editing] * { cursor: text !important; }';
      (document.head || html).appendChild(style);
    }
    html.setAttribute("data-dc-tool", mode);
  }

  function schedule() {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(render);
  }

  function editable(el) {
    return !!(el && el.closest && el.closest("input,textarea,select,[contenteditable=''],[contenteditable='true']"));
  }

  function canScroll(el, dx, dy) {
    for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (isOurs(node)) return false;
      var style = getComputedStyle(node);
      var scroller = node === document.documentElement || node === document.body;
      var y = scroller || /(auto|scroll|overlay)/.test(style.overflowY);
      var x = scroller || /(auto|scroll|overlay)/.test(style.overflowX);
      if (y && dy > 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1) return true;
      if (y && dy < 0 && node.scrollTop > 0) return true;
      if (x && dx > 0 && node.scrollLeft + node.clientWidth < node.scrollWidth - 1) return true;
      if (x && dx < 0 && node.scrollLeft > 0) return true;
    }
    var se = document.scrollingElement || document.documentElement;
    if (dy > 0 && window.scrollY + window.innerHeight < se.scrollHeight - 1) return true;
    if (dy < 0 && window.scrollY > 0) return true;
    return false;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.mark !== MARK) return;
    if (data.type === "mode") {
      mode = ["move", "hand", "comment", "preview"].indexOf(data.mode) >= 0 ? data.mode : "preview";
      hovered = null;
      if (mode !== "move") { selected = null; drag = null; endEdit(true); }
      showToolCursor();
    } else if (data.type === "set-style") {
      var styled = data.dcId ? document.querySelector('[data-dc-id="' + CSS.escape(data.dcId) + '"]') : null;
      if (styled && data.style) applyStyle(styled, data.style);
    } else if (data.type === "set-text") {
      var textNode = data.target ? findText(data.target) : null;
      if (textNode && typeof data.text === "string") textNode.data = data.text;
    } else if (data.type === "tweaks") {
      applyTweaks(data.vars);
    } else if (data.type === "pins") {
      pins = Array.isArray(data.pins) ? data.pins : [];
      selectedId = data.selectedId || null;
    } else if (data.type === "guides") {
      guides = !!data.on;
    } else if (data.type === "zoom") {
      scale = data.zoom > 0 ? 1 / data.zoom : 1;
    } else if (data.type === "clear-selection") {
      picked = null;
      selected = null;
      endEdit(true);
    } else if (data.type === "clear-hover") {
      if (!hovered) return;
      hovered = null;
    }
    schedule();
  });

  document.addEventListener("mousemove", function (event) {
    if ((mode !== "comment" && mode !== "move") || editing) return;
    var next = mode === "move" ? movable(event.target) : target(event.target, event.altKey);
    if (next !== hovered) { hovered = next; schedule(); }
  }, true);

  // The pointer left the page (into the canvas or another artboard).
  document.addEventListener("mouseout", function (event) {
    if (!event.relatedTarget && hovered) { hovered = null; schedule(); }
  });

  // Comment and Move own the pointer: the page's own buttons, links and forms do nothing.
  ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "submit", "touchstart"].forEach(function (type) {
    document.addEventListener(type, function (event) {
      if ((mode !== "comment" && mode !== "move") || isOurs(event.target)) return;
      // The text being edited takes the pointer like any text field: caret, selection, double click.
      if (inEditor(event.target)) { event.stopPropagation(); return; }
      if (type === "dblclick" && mode === "move") {
        var node = textAt(event);
        if (node) startEdit(node);
        else post({ type: "uneditable", reason: "no-text" });
      }
      event.preventDefault();
      event.stopPropagation();
    }, true);
  });

  // Move: press selects the named element under the pointer, dragging moves it.
  window.addEventListener("pointerdown", function (event) {
    if (mode !== "move" || event.button !== 0 || isOurs(event.target)) return;
    if (inEditor(event.target)) return;
    endEdit(true);
    var el = movable(event.target);
    // Pressing was cancelled so the page does nothing, which also kept focus away: take it, so the
    // arrow keys reach this page. The canvas shortcuts still work, since keys are forwarded.
    try { window.focus(); } catch (e) {}
    selected = el;
    hovered = null;
    schedule();
    // What can't move only says so once dragged, so a double click to edit text stays quiet.
    var page = event.target === document.documentElement || event.target === document.body;
    var base = el ? baseOf(el) : null;
    var keys = base && base.kind === "position" ? ["left", "top"] : ["translate"];
    drag = {
      el: el, base: base, x: event.clientX, y: event.clientY, moved: false,
      before: el && base ? inlineOf(el, keys) : null,
      refuse: !el ? (page ? "quiet" : "no-id") : !base ? "unit" : null
    };
    if (el && base) try { el.setPointerCapture(event.pointerId); } catch (e) {}
  }, true);

  window.addEventListener("pointermove", function (event) {
    if (!drag) return;
    var dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    if (drag.refuse) {
      if (drag.refuse !== "quiet") post({ type: "unmovable", reason: drag.refuse });
      drag = null;
      return;
    }
    drag.moved = true;
    applyStyle(drag.el, styleFor(drag.base, dx, dy));
    schedule();
  }, true);

  function endDrag(event) {
    if (!drag) return;
    var done = drag;
    drag = null;
    if (done.moved) reportMove(done.el, done.before, styleFor(done.base, event.clientX - done.x, event.clientY - done.y));
    schedule();
  }
  window.addEventListener("pointerup", endDrag, true);
  window.addEventListener("pointercancel", endDrag, true);

  document.addEventListener("click", function (event) {
    if (isOurs(event.target)) return;
    if (inEditor(event.target)) { event.stopPropagation(); return; }
    if (mode === "move") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (mode === "comment") {
      event.preventDefault();
      event.stopPropagation();
      var el = target(event.target, event.altKey);
      if (!el) return;
      picked = el;
      schedule();
      post({ type: "pick", picked: describe(el), viewport: viewRect(el) });
      return;
    }
    var link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!link) return;
    var href = link.getAttribute("href") || "";
    var match = /^(?:\.\/)?([A-Za-z0-9][A-Za-z0-9._-]*\.html)(?:[?#].*)?$/.exec(href);
    if (match) {
      event.preventDefault();
      post({ type: "navigate", file: match[1] });
    }
  }, true);

  window.addEventListener("wheel", function (event) {
    var zoom = event.ctrlKey || event.metaKey;
    if (!zoom && canScroll(event.target, event.deltaX, event.deltaY)) return;
    event.preventDefault();
    post({ type: "wheel", deltaX: event.deltaX, deltaY: event.deltaY, zoom: zoom, x: event.clientX, y: event.clientY });
  }, { passive: false });

  window.addEventListener("keydown", function (event) {
    var meta = event.metaKey || event.ctrlKey;
    var key = event.key;
    // Editing text: Enter keeps it, Escape puts it back, everything else is typing.
    if (editing) {
      event.stopPropagation();
      if (key === "Enter" || key === "Escape") {
        event.preventDefault();
        endEdit(key === "Enter");
      }
      return;
    }
    if (editable(event.target) && mode === "preview") return;
    if (mode === "move" && selected && key === "Enter" && !meta && !event.shiftKey) {
      var first = firstText(selected);
      if (first) { event.preventDefault(); startEdit(first); return; }
    }
    // Move: the arrow keys nudge the selection 1px, 10px with Shift
    var arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (mode === "move" && selected && arrows[key] && !meta) {
      event.preventDefault();
      var base = baseOf(selected);
      if (!base) return;
      var step = event.shiftKey ? 10 : 1;
      var keys = base.kind === "position" ? ["left", "top"] : ["translate"];
      var before = inlineOf(selected, keys);
      var after = styleFor(base, arrows[key][0] * step, arrows[key][1] * step);
      applyStyle(selected, after);
      reportMove(selected, before, after);
      schedule();
      return;
    }
    if (key === "Escape" && selected) { selected = null; schedule(); }
    var wanted = key === "Escape" || (event.shiftKey && (key === "G" || key === "g")) ||
      (meta && (key === "=" || key === "+" || key === "-" || key === "0" || key === "z" || key === "Z")) ||
      (!meta && !event.shiftKey && (key === "c" || key === "v" || key === "h" || key === "p"));
    if (!wanted) return;
    if (meta) event.preventDefault();
    post({ type: "key", key: key, meta: meta, shift: event.shiftKey });
  }, true);

  window.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);

  function start() {
    ensureLayer();
    showToolCursor();
    if (window.ResizeObserver) {
      var observer = new ResizeObserver(schedule);
      observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
    }
    if (window.MutationObserver && document.body) {
      new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    window.addEventListener("load", schedule);
    setInterval(schedule, 1000);
    lastHeight = pageHeight();
    post({ type: "ready", height: lastHeight });
    schedule();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();`;

/**
 * Blocks loading from the network: designs may use inline and data: resources only. It does not stop
 * a page from navigating itself, and markup before <head> runs before it; the overviews say so.
 */
export const DESIGN_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline' data:",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

function escapeScript(code: string): string {
  return code.replace(/<\/script/gi, "<\\/script");
}

/** The artboard document: the CSP first, then the runtime, then the design's own page. */
export function buildSrcdoc(html: string): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${DESIGN_CSP}"><script>${escapeScript(RUNTIME_SOURCE)}</script>`;
  const headTag = /<head\b[^>]*>/i.exec(html);
  if (headTag) {
    const at = headTag.index + headTag[0].length;
    return `${html.slice(0, at)}${head}${html.slice(at)}`;
  }
  const htmlTag = /<html\b[^>]*>/i.exec(html);
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length;
    return `${html.slice(0, at)}<head>${head}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return `${html.slice(0, at)}<head>${head}</head>${html.slice(at)}`;
}
