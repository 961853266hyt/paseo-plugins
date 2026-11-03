const STYLE_ID = "paseo-image-markup-styles";

/** Prefixed `pim-` so nothing collides with the app's generated class names. */
const CSS = `
.pim-annotate {
  position: absolute; top: 12px; left: 12px; z-index: 10;
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 12px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.18);
  background: rgba(24,24,27,0.85); color: #fafafa; cursor: pointer;
  font: 500 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.pim-annotate:hover { background: rgba(39,39,42,0.95); }
.pim-overlay {
  position: fixed; inset: 0; z-index: 2147483000;
  display: flex; flex-direction: column;
  background: rgba(9,9,11,0.94); color: #fafafa;
  font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.pim-toolbar {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.1);
}
.pim-group { display: flex; align-items: center; gap: 2px; }
.pim-sep { width: 1px; height: 22px; background: rgba(255,255,255,0.14); margin: 0 4px; }
.pim-spacer { flex: 1; }
.pim-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-width: 32px; height: 32px; padding: 0 8px; border-radius: 8px;
  border: 1px solid transparent; background: transparent; color: inherit; cursor: pointer;
  font: inherit;
}
.pim-btn:hover:not(:disabled) { background: rgba(255,255,255,0.08); }
.pim-btn:disabled { opacity: 0.35; cursor: default; }
.pim-btn[aria-pressed="true"] { background: rgba(255,255,255,0.16); border-color: rgba(255,255,255,0.22); }
.pim-btn.pim-primary { background: #fafafa; color: #09090b; font-weight: 600; padding: 0 14px; }
.pim-btn.pim-primary:hover:not(:disabled) { background: #e4e4e7; }
.pim-swatch { width: 20px; height: 20px; border-radius: 999px; border: 2px solid rgba(255,255,255,0.35); }
.pim-btn[aria-pressed="true"] .pim-swatch { border-color: #fafafa; }
.pim-dot { border-radius: 999px; background: currentColor; }
.pim-check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; padding: 0 6px; user-select: none; }
.pim-stage {
  position: relative; flex: 1; min-height: 0; overflow: hidden;
  display: flex; align-items: center; justify-content: center; padding: 16px;
}
.pim-canvas { display: block; box-shadow: 0 4px 24px rgba(0,0,0,0.5); touch-action: none; }
.pim-canvas[data-tool="text"] { cursor: text; }
.pim-canvas:not([data-tool="text"]) { cursor: crosshair; }
.pim-text {
  position: absolute; z-index: 2; min-width: 4ch; margin: 0; padding: 0; border: 1px dashed rgba(255,255,255,0.6);
  background: rgba(0,0,0,0.2); outline: none; resize: none; overflow: hidden; white-space: pre;
  font-weight: 600; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.25;
}
.pim-status { min-height: 20px; padding: 0 12px 10px; color: #fca5a5; text-align: center; }
.pim-status[data-kind="info"] { color: #a1a1aa; }
.pim-toast {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483001;
  max-width: min(90vw, 520px); padding: 10px 14px; border-radius: 10px;
  background: #27272a; color: #fafafa; box-shadow: 0 6px 24px rgba(0,0,0,0.4);
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
}
`;

export function ensureStyles(doc: Document): () => void {
  if (doc.getElementById(STYLE_ID)) return () => {};
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
  return () => style.remove();
}

export function showToast(doc: Document, message: string, durationMs = 5000): void {
  const toast = doc.createElement("div");
  toast.className = "pim-toast";
  toast.setAttribute("role", "status");
  toast.textContent = message;
  doc.body.appendChild(toast);
  setTimeout(() => toast.remove(), durationMs);
}
