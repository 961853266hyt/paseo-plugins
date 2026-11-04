import type { Rect } from "../shared/design";

export const ROW_GAP = 160;
export const COLUMN_GAP = 96;
/** Room above each artboard for its title. */
export const LABEL_HEIGHT = 32;
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 4;
/** Shown until the page reports its own height. */
export const DEFAULT_PAGE_HEIGHT = 900;
export const MAX_PAGE_HEIGHT = 20_000;

export interface BoardSize {
  id: string;
  width: number;
  /** The fixed height, or the page's measured height. */
  height: number;
  group?: string;
  /** Where the user dragged it; such boards keep their spot and take no room in the rows. */
  x?: number;
  y?: number;
}

export interface Placed extends Rect {
  id: string;
}

/**
 * Lays artboards out in rows: a group's variants side by side, ungrouped artboards together in
 * one row. Rows keep the order in which their first artboard appears in the manifest.
 */
export function layoutBoards(boards: readonly BoardSize[]): Placed[] {
  const rows = new Map<string, BoardSize[]>();
  const pinned: Placed[] = [];
  for (const board of boards) {
    if (board.x !== undefined && board.y !== undefined) {
      pinned.push({ id: board.id, x: board.x, y: board.y, width: board.width, height: board.height });
      continue;
    }
    const key = board.group === undefined ? "\u0000ungrouped" : `group:${board.group}`;
    const row = rows.get(key);
    if (row) row.push(board);
    else rows.set(key, [board]);
  }
  const placed: Placed[] = [];
  let y = LABEL_HEIGHT;
  for (const row of rows.values()) {
    let x = 0;
    let tallest = 0;
    for (const board of row) {
      placed.push({ id: board.id, x, y, width: board.width, height: board.height });
      x += board.width + COLUMN_GAP;
      tallest = Math.max(tallest, board.height);
    }
    y += tallest + ROW_GAP + LABEL_HEIGHT;
  }
  return [...placed, ...pinned];
}

export function bounds(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y - LABEL_HEIGHT));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export interface View {
  x: number;
  y: number;
  zoom: number;
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Zooms to `zoom` keeping the world point under the viewport point (px, py) in place. */
export function zoomAt(view: View, zoom: number, px: number, py: number): View {
  const next = clampZoom(zoom);
  const worldX = (px - view.x) / view.zoom;
  const worldY = (py - view.y) / view.zoom;
  return { zoom: next, x: px - worldX * next, y: py - worldY * next };
}

/** Fits `content` in a viewport of the given size, never above 100%. */
export function fitView(content: Rect | null, width: number, height: number, padding = 48): View {
  if (!content || width <= 0 || height <= 0) return { x: padding, y: padding, zoom: 1 };
  const zoom = clampZoom(
    Math.min(1, (width - padding * 2) / Math.max(content.width, 1), (height - padding * 2) / Math.max(content.height, 1)),
  );
  return {
    zoom,
    x: (width - content.width * zoom) / 2 - content.x * zoom,
    y: Math.max(padding, (height - content.height * zoom) / 2) - content.y * zoom,
  };
}

/** Centers `rect` (an element in world space) without changing the zoom. */
export function centerOn(view: View, rect: Rect, width: number, height: number): View {
  return {
    zoom: view.zoom,
    x: width / 2 - (rect.x + rect.width / 2) * view.zoom,
    y: height / 2 - (rect.y + rect.height / 2) * view.zoom,
  };
}

/** Zoom steps for the + and − buttons, as in most design tools. */
export const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > zoom + 0.001) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.001) ?? MIN_ZOOM;
}
