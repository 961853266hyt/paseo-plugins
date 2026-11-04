import { PROTOCOL_MARK } from "../shared/runtime-protocol";

/**
 * Runs inside every artboard's iframe. Plain JavaScript in a string, not a compiled function: a
 * bundler's helpers (such as esbuild's __name) would not exist inside the iframe.
 *
 * It draws hover and selection boxes, numbered comment pins and layout guides in a shadow root,
 * reports picked elements, forwards zoom and pan gestures, and reports the page height. It only
 * ever talks to its parent window.
 */
export const RUNTIME_SOURCE = String.raw`(function () {
  "use strict";
  var MARK = ${JSON.stringify(PROTOCOL_MARK)};
  var mode = "browse";
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
  var frameQueued = false;
  var lastHeight = -1;
  var COLORS = { pending: "#d97757", sent: "#3b82f6", resolved: "#16a34a" };

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
    layer = document.createElement("div");
    root.appendChild(grid);
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
    place(hoverBox, mode === "comment" && hovered && hovered.isConnected ? pageRect(hovered) : null, 1.5);
    place(pickBox, picked && picked.isConnected ? pageRect(picked) : null, 2);
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
      mode = data.mode === "comment" ? "comment" : "browse";
      hovered = null;
      if (document.documentElement) document.documentElement.style.cursor = mode === "comment" ? "crosshair" : "";
    } else if (data.type === "pins") {
      pins = Array.isArray(data.pins) ? data.pins : [];
      selectedId = data.selectedId || null;
    } else if (data.type === "guides") {
      guides = !!data.on;
    } else if (data.type === "zoom") {
      scale = data.zoom > 0 ? 1 / data.zoom : 1;
    } else if (data.type === "clear-selection") {
      picked = null;
    } else if (data.type === "clear-hover") {
      if (!hovered) return;
      hovered = null;
    }
    schedule();
  });

  document.addEventListener("mousemove", function (event) {
    if (mode !== "comment") return;
    var next = target(event.target, event.altKey);
    if (next !== hovered) { hovered = next; schedule(); }
  }, true);

  // The pointer left the page (into the canvas or another artboard).
  document.addEventListener("mouseout", function (event) {
    if (!event.relatedTarget && hovered) { hovered = null; schedule(); }
  });

  ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "submit", "touchstart"].forEach(function (type) {
    document.addEventListener(type, function (event) {
      if (mode !== "comment" || isOurs(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
  });

  document.addEventListener("click", function (event) {
    if (isOurs(event.target)) return;
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
    if (editable(event.target)) return;
    var meta = event.metaKey || event.ctrlKey;
    var key = event.key;
    var wanted = key === "Escape" || (event.shiftKey && (key === "G" || key === "g")) ||
      (meta && (key === "=" || key === "+" || key === "-" || key === "0")) ||
      (!meta && !event.shiftKey && (key === "c" || key === "v"));
    if (!wanted) return;
    if (meta) event.preventDefault();
    post({ type: "key", key: key, meta: meta, shift: event.shiftKey });
  }, true);

  window.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);

  function start() {
    ensureLayer();
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
