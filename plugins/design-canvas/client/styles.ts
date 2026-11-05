import type { PluginHostProps } from "@getpaseo/plugin/client";
import { COMMENT_CURSOR } from "./cursors";

export type ThemeColors = PluginHostProps["theme"]["colors"];

/** Theme colors as CSS variables on the canvas root, so a theme switch restyles without a rebuild. */
export function applyTheme(root: HTMLElement, colors: ThemeColors): void {
  const vars: Record<string, string> = {
    "--dc-bg": colors.surface0,
    "--dc-surface": colors.surface1,
    "--dc-surface2": colors.surface2,
    "--dc-border": colors.border,
    "--dc-fg": colors.foreground,
    "--dc-muted": colors.foregroundMuted,
    "--dc-accent": colors.accent,
    "--dc-accent-fg": colors.accentForeground,
    "--dc-success": colors.statusSuccess,
    "--dc-warning": colors.statusWarning,
    "--dc-danger": colors.statusDanger,
  };
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
}

export const CANVAS_CSS = `
.dc-root { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--dc-bg); color: var(--dc-fg);
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; overflow: hidden; outline: none; }
.dc-root * { box-sizing: border-box; }
.dc-root button { font: inherit; color: inherit; }
.dc-toolbar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--dc-border);
  background: var(--dc-surface); flex: none; min-height: 42px; flex-wrap: wrap; }
.dc-sep { width: 1px; align-self: stretch; margin: 4px 2px; background: var(--dc-border); }
.dc-spacer { flex: 1; }
.dc-btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 6px;
  border: 1px solid transparent; background: transparent; cursor: pointer; white-space: nowrap; }
.dc-btn:hover:not(:disabled) { background: var(--dc-surface2); }
.dc-btn:disabled { opacity: .5; cursor: default; }
.dc-btn.dc-on { background: var(--dc-surface2); border-color: var(--dc-border); }
.dc-btn.dc-primary { background: var(--dc-accent); color: var(--dc-accent-fg); }
.dc-btn.dc-primary:hover:not(:disabled) { background: var(--dc-accent); filter: brightness(1.08); }
.dc-btn.dc-icon { width: 28px; padding: 0; justify-content: center; }
.dc-btn[data-tip] { position: relative; }
.dc-btn[data-tip]::after { content: attr(data-tip); position: absolute; top: calc(100% + 6px); left: 50%; transform: translateX(-50%);
  padding: 4px 8px; border-radius: 6px; background: var(--dc-fg); color: var(--dc-bg); font-size: 12px; font-weight: 500; line-height: 16px;
  white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity 0.08s; z-index: 40; box-shadow: 0 4px 12px rgba(0,0,0,.2); }
.dc-btn[data-tip][data-key]::after { content: attr(data-tip) "\\00a0\\00a0\\00a0" attr(data-key); }
.dc-btn[data-tip]:hover::after, .dc-btn[data-tip]:focus-visible::after { opacity: 1; transition-delay: 0.4s; }
.dc-popover .dc-btn[data-tip]::after { left: auto; right: 0; transform: none; }
.dc-btn svg { width: 15px; height: 15px; flex: none; }
.dc-picker { display: inline-flex; align-items: center; gap: 6px; height: 28px; max-width: 280px; padding: 0 7px 0 10px; border-radius: 6px;
  border: 1px solid var(--dc-border); background: var(--dc-bg); color: var(--dc-fg); font: inherit; cursor: pointer; }
.dc-picker:hover, .dc-picker.dc-on { background: var(--dc-surface2); }
.dc-picker[hidden] { display: none; }
.dc-picker-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.dc-picker svg { width: 14px; height: 14px; flex: none; color: var(--dc-muted); }
.dc-menu { position: absolute; z-index: 25; min-width: 260px; max-width: 380px; max-height: 60%; overflow: auto; padding: 4px; border-radius: 10px;
  background: var(--dc-surface); border: 1px solid var(--dc-border); box-shadow: 0 12px 32px rgba(0,0,0,.18); }
/* One grid for every row: 4px menu padding, 8px row inset, a 16px icon column, 8px gap, then the name. */
.dc-menu-item { position: relative; display: flex; align-items: center; height: 32px; border-radius: 6px; }
.dc-menu-item:hover, .dc-menu-item:focus-within { background: var(--dc-surface2); }
.dc-menu-pick { flex: 1; min-width: 0; height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 8px; border: 0; border-radius: 6px;
  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; outline: none; }
.dc-menu-pick:focus-visible { box-shadow: inset 0 0 0 1.5px var(--dc-accent); }
.dc-menu-icon { width: 16px; height: 16px; flex: none; display: grid; place-items: center; color: var(--dc-muted); }
.dc-current .dc-menu-icon { color: var(--dc-accent); }
.dc-menu-icon svg { width: 16px; height: 16px; display: block; }
.dc-menu-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dc-current .dc-menu-title { font-weight: 600; }
.dc-menu-actions { display: flex; gap: 2px; margin-right: 4px; opacity: 0; }
.dc-menu-item:hover .dc-menu-actions, .dc-menu-item:focus-within .dc-menu-actions { opacity: 1; }
.dc-btn.dc-act { width: 24px; height: 24px; color: var(--dc-muted); }
.dc-btn.dc-act svg { width: 14px; height: 14px; }
.dc-btn.dc-act:hover:not(:disabled) { background: var(--dc-border); color: var(--dc-fg); }
.dc-btn.dc-act-danger:hover:not(:disabled) { color: var(--dc-danger); }
.dc-menu .dc-btn[data-tip]::after { left: auto; right: 0; transform: none; }
/* Renaming: the field starts where the name was. */
.dc-menu-item.dc-renaming { gap: 8px; padding: 0 8px; background: var(--dc-surface2); }
.dc-menu-field { flex: 1; min-width: 0; height: 24px; margin: 0 -6px; padding: 0 5px; border: 1px solid var(--dc-accent); border-radius: 5px;
  background: var(--dc-bg); color: var(--dc-fg); font: inherit; font-weight: 600; outline: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dc-accent) 18%, transparent); }
/* Deleting: the row asks. */
.dc-menu-item.dc-asking { gap: 8px; padding: 0 4px 0 8px; background: color-mix(in srgb, var(--dc-danger) 10%, var(--dc-surface)); }
.dc-asking .dc-menu-icon, .dc-asking .dc-menu-title { color: var(--dc-danger); }
.dc-btn.dc-mini { height: 24px; padding: 0 8px; font-size: 12px; color: var(--dc-muted); }
.dc-btn.dc-mini:hover:not(:disabled) { background: color-mix(in srgb, var(--dc-fg) 8%, transparent); color: var(--dc-fg); }
.dc-btn.dc-mini-danger { background: var(--dc-danger); color: #fff; font-weight: 600; }
.dc-btn.dc-mini-danger:hover:not(:disabled) { background: var(--dc-danger); color: #fff; filter: brightness(1.08); }
.dc-menu-sep { height: 1px; margin: 4px 8px; background: var(--dc-border); }
.dc-menu-new { color: var(--dc-fg); }
.dc-btn.dc-danger { background: var(--dc-danger); color: #fff; }
.dc-btn.dc-danger:hover:not(:disabled) { background: var(--dc-danger); filter: brightness(1.08); }
.dc-board-label .dc-count { display: inline-grid; place-items: center; min-width: 17px; height: 17px; padding: 0 5px; border-radius: 9px;
  background: #0d99ff; color: #fff; font-size: 10.5px; font-weight: 700; line-height: 1; opacity: 0; transform: scale(.6); transition: opacity .14s, transform .14s; }
.dc-board-label .dc-count.dc-on { opacity: 1; transform: none; }
.dc-select { height: 28px; max-width: 260px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--dc-border);
  background: var(--dc-bg); color: var(--dc-fg); font: inherit; }
.dc-zoom { min-width: 48px; text-align: center; font-variant-numeric: tabular-nums; color: var(--dc-muted); }
.dc-status { display: inline-flex; align-items: center; gap: 6px; color: var(--dc-muted); white-space: nowrap; }
.dc-dot { width: 8px; height: 8px; border-radius: 4px; background: var(--dc-accent); animation: dc-pulse 1.2s ease-in-out infinite; }
@keyframes dc-pulse { 50% { opacity: .3; } }
.dc-body { position: relative; flex: 1; display: flex; min-height: 0; }
.dc-viewport { position: relative; flex: 1; overflow: hidden; cursor: default; touch-action: none;
  background-color: var(--dc-bg);
  background-image: radial-gradient(circle, color-mix(in srgb, var(--dc-muted) 28%, transparent) 1px, transparent 1px);
  background-size: 20px 20px; }
.dc-root[data-mode="comment"] .dc-viewport { cursor: ${COMMENT_CURSOR}; }
.dc-viewport.dc-grab { cursor: grab; }
.dc-viewport.dc-grabbing { cursor: grabbing; }
.dc-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.dc-world.dc-panning iframe { pointer-events: none; }
.dc-board { position: absolute; }
.dc-board-label { position: absolute; left: 0; bottom: 100%; white-space: nowrap; color: var(--dc-muted);
  transform-origin: 0 100%; padding-bottom: 6px; display: flex; gap: 8px; align-items: baseline; cursor: pointer; }
.dc-board-label b { color: var(--dc-fg); font-weight: 600; }
.dc-board-frame { display: block; border: 0; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.12), 0 8px 24px rgba(0,0,0,.10);
  border-radius: 2px; }
.dc-root[data-mode="move"] .dc-board-label { cursor: move; }
.dc-root[data-mode="hand"] .dc-board-label { cursor: grab; }
.dc-board.dc-focus .dc-board-frame { outline: 2px solid var(--dc-accent); outline-offset: 2px; }
.dc-board-error { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px; text-align: center;
  background: var(--dc-surface); color: var(--dc-danger); border: 1px dashed var(--dc-border); font-size: 14px; }
.dc-banner { margin: 8px; padding: 8px 12px; border-radius: 6px; background: color-mix(in srgb, var(--dc-danger) 14%, var(--dc-surface));
  color: var(--dc-fg); border: 1px solid color-mix(in srgb, var(--dc-danger) 40%, transparent); position: absolute; left: 0; right: 0; top: 0; z-index: 3; }
.dc-empty { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px; z-index: 2; }
.dc-card { width: min(520px, 100%); padding: 20px; border-radius: 10px; background: var(--dc-surface); border: 1px solid var(--dc-border);
  box-shadow: 0 12px 32px rgba(0,0,0,.18); }
.dc-card h2 { margin: 0 0 6px; font-size: 16px; }
.dc-card p { margin: 0 0 12px; color: var(--dc-muted); }
.dc-textarea { width: 100%; min-height: 96px; resize: vertical; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--dc-border);
  background: var(--dc-bg); color: var(--dc-fg); font: inherit; outline: none; }
.dc-textarea:focus { border-color: var(--dc-accent); }
.dc-row { display: flex; gap: 8px; justify-content: flex-end; align-items: center; margin-top: 10px; }
.dc-hint { color: var(--dc-muted); font-size: 12px; margin-right: auto; }
.dc-modal { position: absolute; inset: 0; z-index: 20; display: grid; place-items: center; background: rgba(0,0,0,.35); padding: 24px; }
.dc-popover { position: absolute; z-index: 10; width: 300px; padding: 10px; border-radius: 8px; background: var(--dc-surface);
  border: 1px solid var(--dc-border); box-shadow: 0 10px 28px rgba(0,0,0,.22); }
.dc-popover .dc-textarea { min-height: 72px; }
.dc-popover-head { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; color: var(--dc-muted); font-size: 12px; }
.dc-popover-head b { color: var(--dc-fg); }
.dc-popover-body { white-space: pre-wrap; margin: 4px 0 8px; }
.dc-resolution { margin: 0 0 8px; padding: 6px 8px; border-radius: 6px; background: color-mix(in srgb, var(--dc-success) 12%, var(--dc-bg));
  font-size: 12px; }
.dc-side { width: 300px; flex: none; border-left: 1px solid var(--dc-border); background: var(--dc-surface); display: flex; flex-direction: column; min-height: 0; }
.dc-side[hidden] { display: none; }
.dc-side-head { display: flex; align-items: center; gap: 4px; padding: 7px 8px; border-bottom: 1px solid var(--dc-border); font-weight: 600; }
.dc-side-head .dc-tab { height: 26px; padding: 0 8px; border-radius: 6px; border: 1px solid transparent; background: transparent;
  cursor: pointer; font-weight: 600; color: var(--dc-muted); white-space: nowrap; }
.dc-side-head .dc-tab:hover { color: var(--dc-fg); }
.dc-side-head .dc-tab.dc-on { color: var(--dc-fg); background: var(--dc-surface2); }
.dc-pane-bar { display: flex; justify-content: flex-end; padding: 6px 12px 0; }
.dc-pane { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.dc-pane[hidden] { display: none; }
.dc-side-list { flex: 1; overflow: auto; padding: 6px; }
.dc-side-list.dc-tweaks { padding: 4px 12px; }
.dc-tweak { position: relative; margin: 0 -8px; padding: 10px 8px; border-radius: 8px; transition: background .12s, box-shadow .12s; }
.dc-tweak + .dc-tweak::before { content: ""; position: absolute; left: 8px; right: 8px; top: 0; border-top: 1px solid var(--dc-border); }
.dc-tweak:hover, .dc-tweak.dc-linked { background: var(--dc-bg); box-shadow: 0 0 0 1px var(--dc-border); }
.dc-tweak.dc-linked { box-shadow: 0 0 0 1.5px #0d99ff; }
.dc-tweak:hover::before, .dc-tweak:hover + .dc-tweak::before, .dc-tweak.dc-linked::before, .dc-tweak.dc-linked + .dc-tweak::before { opacity: 0; }
.dc-tweak-uses { display: flex; align-items: center; gap: 6px; margin-top: 7px; font-size: 12px; color: var(--dc-muted); }
.dc-tweak-uses:empty { display: none; }
.dc-tweak-uses::before { content: ""; width: 7px; height: 7px; flex: none; border-radius: 2px; border: 1.5px solid #0d99ff; background: rgba(13,153,255,.12); }
.dc-tweak-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; min-height: 18px; }
.dc-tweak-name { flex: 1; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dc-tweak.dc-changed .dc-tweak-name::after { content: ""; display: inline-block; width: 6px; height: 6px; margin-left: 6px;
  border-radius: 3px; background: var(--dc-accent); vertical-align: middle; }
.dc-tweak-value { color: var(--dc-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.dc-range { display: block; width: 100%; margin: 0; accent-color: var(--dc-accent); cursor: pointer; }
.dc-tweak-color { display: flex; gap: 8px; align-items: center; }
.dc-tweak-color input[type="color"] { width: 32px; height: 28px; padding: 2px; flex: none; border: 1px solid var(--dc-border);
  border-radius: 6px; background: var(--dc-bg); cursor: pointer; }
.dc-input { flex: 1; min-width: 0; height: 28px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--dc-border);
  background: var(--dc-bg); color: var(--dc-fg); font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; outline: none; }
.dc-input:focus { border-color: var(--dc-accent); }
.dc-tweak .dc-select { width: 100%; max-width: none; }
.dc-segments { display: flex; gap: 2px; padding: 2px; border-radius: 7px; border: 1px solid var(--dc-border); background: var(--dc-bg); }
.dc-segment { flex: 1; min-width: 0; height: 24px; padding: 0 6px; border: 0; border-radius: 5px; background: transparent;
  color: var(--dc-muted); font-size: 12px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dc-segment:hover { color: var(--dc-fg); }
.dc-segment.dc-on { background: var(--dc-surface2); color: var(--dc-fg); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
.dc-switch { position: relative; flex: none; width: 30px; height: 18px; cursor: pointer; }
.dc-switch input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: pointer; }
.dc-switch span { position: absolute; inset: 0; border-radius: 9px; background: var(--dc-border); transition: background .12s; pointer-events: none; }
.dc-switch span::after { content: ""; position: absolute; left: 2px; top: 2px; width: 14px; height: 14px; border-radius: 7px;
  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .12s; }
.dc-switch input:checked + span { background: var(--dc-accent); }
.dc-switch input:checked + span::after { transform: translateX(12px); }
.dc-switch input:focus-visible + span { outline: 2px solid var(--dc-accent); outline-offset: 2px; }
.dc-tweak-warn { margin-top: 6px; font-size: 12px; color: var(--dc-warning); }
.dc-row.dc-tweak-actions { margin-top: 0; }
.dc-tweak-actions[hidden] { display: none; }
.dc-tweak-actions .dc-btn { flex: 1; justify-content: center; border-color: var(--dc-border); }
.dc-side-section { margin: 10px 6px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--dc-muted); }
.dc-item { padding: 8px 10px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
.dc-item:hover { background: var(--dc-surface2); }
.dc-item.dc-on { border-color: var(--dc-accent); }
.dc-item-head { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--dc-muted); }
.dc-num { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px 10px 10px 2px;
  color: #fff; font-weight: 600; font-size: 11px; }
.dc-num.pending { background: #d97757; } .dc-num.sent { background: #3b82f6; } .dc-num.resolved { background: #16a34a; }
.dc-item-body { margin-top: 4px; white-space: pre-wrap; overflow-wrap: anywhere; }
.dc-item-meta { margin-top: 2px; font-size: 12px; color: var(--dc-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dc-side-foot { padding: 10px; border-top: 1px solid var(--dc-border); display: flex; flex-direction: column; gap: 6px; }
.dc-side-foot .dc-btn { justify-content: center; }
.dc-check { display: flex; gap: 6px; align-items: center; color: var(--dc-muted); font-size: 12px; cursor: pointer; }
.dc-toast { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 30; padding: 8px 14px; border-radius: 8px;
  background: var(--dc-fg); color: var(--dc-bg); box-shadow: 0 6px 18px rgba(0,0,0,.25); max-width: 80%; }
.dc-muted { color: var(--dc-muted); }
.dc-side-empty { padding: 10px; color: var(--dc-muted); }
`;
