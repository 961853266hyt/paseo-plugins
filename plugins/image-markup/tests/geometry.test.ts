import { describe, expect, test } from "vitest";
import {
  arrowHead,
  blurBlockSize,
  clampRect,
  EMPTY_SCENE,
  fitScale,
  History,
  isMeaningfulDrag,
  outputRect,
  rectFromPoints,
  strokeWidth,
} from "../client/geometry";

describe("geometry", () => {
  test("a rectangle is the same whichever way it is dragged", () => {
    expect(rectFromPoints({ x: 30, y: 40 }, { x: 10, y: 5 })).toEqual({ x: 10, y: 5, width: 20, height: 35 });
  });

  test("clampRect keeps the part inside the image on whole pixels", () => {
    const size = { width: 100, height: 50 };
    expect(clampRect({ x: -10, y: 10.4, width: 50, height: 100 }, size)).toEqual({ x: 0, y: 10, width: 40, height: 40 });
    expect(clampRect({ x: 120, y: 0, width: 10, height: 10 }, size)).toBeNull();
  });

  test("the arrow head is symmetric around the shaft and sits behind its tip", () => {
    const [left, right] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 4);
    expect(left.x).toBeCloseTo(right.x);
    expect(left.y).toBeCloseTo(-right.y);
    expect(left.x).toBeLessThan(100);
  });

  test("strokes and blur blocks grow with the image", () => {
    expect(strokeWidth({ width: 800, height: 600 }, 2)).toBe(4);
    expect(strokeWidth({ width: 3840, height: 2160 }, 2)).toBeGreaterThan(strokeWidth({ width: 800, height: 600 }, 2));
    expect(blurBlockSize({ width: 400, height: 40 })).toBe(6);
    expect(blurBlockSize({ width: 400, height: 400 })).toBe(50);
  });

  test("fitScale shrinks to fit and never enlarges", () => {
    expect(fitScale({ width: 2000, height: 1000 }, { width: 1000, height: 1000 })).toBe(0.5);
    expect(fitScale({ width: 200, height: 100 }, { width: 1000, height: 1000 })).toBe(1);
  });

  test("a drag shorter than the threshold is a click", () => {
    expect(isMeaningfulDrag({ x: 0, y: 0 }, { x: 2, y: 1 })).toBe(false);
    expect(isMeaningfulDrag({ x: 0, y: 0 }, { x: 0, y: 5 })).toBe(true);
  });

  test("the export covers the crop, or the whole image without one", () => {
    const size = { width: 100, height: 80 };
    expect(outputRect(EMPTY_SCENE, size)).toEqual({ x: 0, y: 0, width: 100, height: 80 });
    expect(outputRect({ shapes: [], crop: { x: 10, y: 10, width: 200, height: 20 } }, size)).toEqual({
      x: 10,
      y: 10,
      width: 90,
      height: 20,
    });
  });
});

describe("History", () => {
  test("undo and redo step through scenes, and a new edit drops the redo branch", () => {
    const history = new History();
    const a = { shapes: [], crop: { x: 0, y: 0, width: 1, height: 1 } };
    const b = { shapes: [], crop: { x: 0, y: 0, width: 2, height: 2 } };
    const c = { shapes: [], crop: null };
    history.push(a);
    history.push(b);
    expect(history.isEdited).toBe(true);
    history.undo();
    expect(history.scene).toBe(a);
    expect(history.canRedo).toBe(true);
    history.redo();
    expect(history.scene).toBe(b);
    history.undo();
    history.push(c);
    expect(history.canRedo).toBe(false);
    history.undo();
    history.undo();
    expect(history.scene).toBe(EMPTY_SCENE);
    expect(history.canUndo).toBe(false);
    history.undo();
    expect(history.scene).toBe(EMPTY_SCENE);
  });
});
