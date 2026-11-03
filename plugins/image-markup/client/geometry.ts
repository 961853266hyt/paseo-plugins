/** Every coordinate is in the image's own pixels, whatever size the editor shows it at. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export type Shape =
  | { readonly kind: "pen"; readonly color: string; readonly width: number; readonly points: readonly Point[] }
  | { readonly kind: "arrow"; readonly color: string; readonly width: number; readonly from: Point; readonly to: Point }
  | { readonly kind: "rect"; readonly color: string; readonly width: number; readonly from: Point; readonly to: Point }
  | { readonly kind: "text"; readonly color: string; readonly size: number; readonly at: Point; readonly text: string }
  | { readonly kind: "blur"; readonly from: Point; readonly to: Point };

/** What the editor has drawn so far. Undo and redo step through whole scenes. */
export interface Scene {
  readonly shapes: readonly Shape[];
  readonly crop: Rect | null;
}

export const EMPTY_SCENE: Scene = { shapes: [], crop: null };

/** The rectangle two corners span, in either drag direction. */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export function clampPoint(point: Point, size: Size): Point {
  return {
    x: Math.min(Math.max(point.x, 0), size.width),
    y: Math.min(Math.max(point.y, 0), size.height),
  };
}

/** The part of `rect` inside the image, with whole-pixel edges; null when nothing is left. */
export function clampRect(rect: Rect, size: Size): Rect | null {
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(size.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(size.height, Math.ceil(rect.y + rect.height));
  if (right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The stroke width for a size step. It grows with the image, so a mark on a 4K screenshot reads
 * as clearly as one on a small crop.
 */
export function strokeWidth(image: Size, step: 1 | 2 | 3): number {
  const base = Math.max(2, Math.round(Math.max(image.width, image.height) / 400));
  return base * [1, 2, 4][step - 1]!;
}

/** Font size in image pixels for a size step. */
export function fontSize(image: Size, step: 1 | 2 | 3): number {
  return Math.max(14, Math.round(Math.max(image.width, image.height) / 60)) * [1, 1.5, 2.25][step - 1]!;
}

/** The two outer corners of an arrow's head, which sits on `to`. */
export function arrowHead(from: Point, to: Point, width: number): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const length = Math.max(10, width * 4);
  const spread = Math.PI / 7;
  return [
    { x: to.x - length * Math.cos(angle - spread), y: to.y - length * Math.sin(angle - spread) },
    { x: to.x - length * Math.cos(angle + spread), y: to.y - length * Math.sin(angle + spread) },
  ];
}

/** Side of the square blocks a blurred region is pixelated into: coarse enough to hide text. */
export function blurBlockSize(region: Size): number {
  return Math.max(6, Math.round(Math.min(region.width, region.height) / 8));
}

/** Whether a drag was long enough to mean a shape rather than a stray click. */
export function isMeaningfulDrag(a: Point, b: Point, minimum = 3): boolean {
  return Math.abs(a.x - b.x) >= minimum || Math.abs(a.y - b.y) >= minimum;
}

/** The scale that fits `content` inside `box` without enlarging it. */
export function fitScale(content: Size, box: Size): number {
  if (content.width <= 0 || content.height <= 0) return 1;
  return Math.min(1, box.width / content.width, box.height / content.height);
}

/** The image the export produces: the crop when there is one, else the whole image. */
export function outputRect(scene: Scene, image: Size): Rect {
  const full = { x: 0, y: 0, width: image.width, height: image.height };
  return (scene.crop && clampRect(scene.crop, image)) ?? full;
}

/** A linear undo history of scenes. */
export class History {
  private past: Scene[] = [];
  private future: Scene[] = [];

  constructor(private current: Scene = EMPTY_SCENE) {}

  get scene(): Scene {
    return this.current;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get isEdited(): boolean {
    return this.current.shapes.length > 0 || this.current.crop !== null;
  }

  push(next: Scene): void {
    this.past.push(this.current);
    this.future = [];
    this.current = next;
  }

  undo(): void {
    const previous = this.past.pop();
    if (!previous) return;
    this.future.push(this.current);
    this.current = previous;
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.current);
    this.current = next;
  }
}
