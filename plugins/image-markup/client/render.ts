import {
  arrowHead,
  blurBlockSize,
  clampRect,
  outputRect,
  rectFromPoints,
  type Scene,
  type Shape,
  type Size,
} from "./geometry";

export type MakeCanvas = (width: number, height: number) => HTMLCanvasElement;

export const makeCanvas: MakeCanvas = (width, height) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

export const TEXT_FONT = '600 {size}px system-ui, -apple-system, "Segoe UI", sans-serif';

export function textFont(size: number): string {
  return TEXT_FONT.replace("{size}", String(Math.round(size)));
}

/** Line height of the text tool, as a multiple of its font size. */
export const TEXT_LINE_HEIGHT = 1.25;

/**
 * Draws the image and every shape onto `ctx`, which spans the whole image. Shapes draw in order,
 * so a blur hides what lies under it, and marks made after it stay sharp.
 */
export function renderScene(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  size: Size,
  shapes: readonly Shape[],
  make: MakeCanvas = makeCanvas,
): void {
  ctx.clearRect(0, 0, size.width, size.height);
  ctx.drawImage(image, 0, 0, size.width, size.height);
  for (const shape of shapes) drawShape(ctx, shape, size, make);
}

export function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  size: Size,
  make: MakeCanvas = makeCanvas,
): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (shape.kind) {
    case "pen": {
      const [first, ...rest] = shape.points;
      if (!first) break;
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = shape.width;
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      // A single click still leaves a dot.
      if (rest.length === 0) ctx.lineTo(first.x + 0.01, first.y);
      for (const point of rest) ctx.lineTo(point.x, point.y);
      ctx.stroke();
      break;
    }
    case "arrow": {
      const [left, right] = arrowHead(shape.from, shape.to, shape.width);
      ctx.strokeStyle = shape.color;
      ctx.fillStyle = shape.color;
      ctx.lineWidth = shape.width;
      ctx.beginPath();
      ctx.moveTo(shape.from.x, shape.from.y);
      ctx.lineTo(shape.to.x, shape.to.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(shape.to.x, shape.to.y);
      ctx.lineTo(left.x, left.y);
      ctx.lineTo(right.x, right.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
    case "rect": {
      const rect = rectFromPoints(shape.from, shape.to);
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = shape.width;
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      break;
    }
    case "text": {
      ctx.fillStyle = shape.color;
      ctx.font = textFont(shape.size);
      ctx.textBaseline = "top";
      // A dark or light halo keeps the text readable on any background.
      ctx.lineWidth = Math.max(2, shape.size / 8);
      ctx.strokeStyle = isLight(shape.color) ? "rgba(0,0,0,0.75)" : "rgba(255,255,255,0.85)";
      shape.text.split("\n").forEach((line, index) => {
        const y = shape.at.y + index * shape.size * TEXT_LINE_HEIGHT;
        ctx.strokeText(line, shape.at.x, y);
        ctx.fillText(line, shape.at.x, y);
      });
      break;
    }
    case "blur":
      pixelate(ctx, shape, size, make);
      break;
  }
  ctx.restore();
}

/** Pixelates the region in place. Unlike a soft blur, coarse blocks leave no readable text. */
function pixelate(
  ctx: CanvasRenderingContext2D,
  shape: Extract<Shape, { kind: "blur" }>,
  size: Size,
  make: MakeCanvas,
): void {
  const region = clampRect(rectFromPoints(shape.from, shape.to), size);
  if (!region) return;
  const block = blurBlockSize(region);
  const small = make(Math.max(1, Math.ceil(region.width / block)), Math.max(1, Math.ceil(region.height / block)));
  const smallCtx = small.getContext("2d");
  if (!smallCtx) return;
  smallCtx.imageSmoothingEnabled = true;
  smallCtx.drawImage(ctx.canvas, region.x, region.y, region.width, region.height, 0, 0, small.width, small.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, small.width, small.height, region.x, region.y, region.width, region.height);
}

function isLight(color: string): boolean {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r! + 0.587 * g! + 0.114 * b! > 160;
}

/** Renders the scene at the image's full resolution, cropped, as a PNG. */
export async function exportPng(
  image: CanvasImageSource,
  size: Size,
  scene: Scene,
  make: MakeCanvas = makeCanvas,
): Promise<Blob> {
  const full = make(size.width, size.height);
  const fullCtx = full.getContext("2d");
  if (!fullCtx) throw new Error("Canvas is unavailable");
  renderScene(fullCtx, image, size, scene.shapes, make);
  const crop = outputRect(scene, size);
  const out = make(crop.width, crop.height);
  const outCtx = out.getContext("2d");
  if (!outCtx) throw new Error("Canvas is unavailable");
  outCtx.drawImage(full, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  return new Promise((resolve, reject) => {
    out.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG export failed"))), "image/png");
  });
}
