import { describe, expect, test } from "vitest";
import {
  bounds,
  COLUMN_GAP,
  fitView,
  LABEL_HEIGHT,
  layoutBoards,
  MAX_ZOOM,
  ROW_GAP,
  stepZoom,
  zoomAt,
} from "../client/layout";

describe("layout", () => {
  test("a group's variants share a row; ungrouped boards share another", () => {
    const placed = layoutBoards([
      { id: "a", width: 1000, height: 800, group: "home" },
      { id: "solo", width: 400, height: 300 },
      { id: "b", width: 390, height: 844, group: "home" },
      { id: "solo2", width: 500, height: 200 },
    ]);
    const byId = Object.fromEntries(placed.map((rect) => [rect.id, rect]));
    expect(byId.a).toMatchObject({ x: 0, y: LABEL_HEIGHT });
    expect(byId.b).toMatchObject({ x: 1000 + COLUMN_GAP, y: LABEL_HEIGHT });
    const secondRow = LABEL_HEIGHT + 844 + ROW_GAP + LABEL_HEIGHT;
    expect(byId.solo).toMatchObject({ x: 0, y: secondRow });
    expect(byId.solo2).toMatchObject({ x: 400 + COLUMN_GAP, y: secondRow });
  });

  test("bounds include the labels", () => {
    expect(bounds([{ x: 0, y: LABEL_HEIGHT, width: 100, height: 50 }])).toEqual({ x: 0, y: 0, width: 100, height: 50 + LABEL_HEIGHT });
    expect(bounds([])).toBeNull();
  });
});

describe("view", () => {
  test("zooming keeps the point under the cursor in place", () => {
    const view = { x: 10, y: 20, zoom: 1 };
    const next = zoomAt(view, 2, 110, 220);
    expect(next.zoom).toBe(2);
    expect((110 - next.x) / next.zoom).toBeCloseTo((110 - view.x) / view.zoom);
    expect((220 - next.y) / next.zoom).toBeCloseTo((220 - view.y) / view.zoom);
    expect(zoomAt(view, 100, 0, 0).zoom).toBe(MAX_ZOOM);
  });

  test("fit never zooms past 100% and centers the content", () => {
    const small = fitView({ x: 0, y: 0, width: 100, height: 100 }, 1000, 800);
    expect(small.zoom).toBe(1);
    expect(small.x).toBe(450);
    const large = fitView({ x: 0, y: 0, width: 4000, height: 1000 }, 1000, 800);
    expect(large.zoom).toBeCloseTo((1000 - 96) / 4000);
  });

  test("zoom steps move to the next stop", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(0.43, 1)).toBe(0.5);
    expect(stepZoom(0.43, -1)).toBe(0.33);
  });
});

describe("dragged artboards", () => {
  test("keep their position and leave the automatic rows alone", () => {
    const placed = layoutBoards([
      { id: "a", width: 400, height: 300 },
      { id: "b", width: 400, height: 300, x: 900, y: -200 },
      { id: "c", width: 400, height: 300 },
    ]);
    const byId = Object.fromEntries(placed.map((rect) => [rect.id, rect]));
    expect(byId.b).toMatchObject({ x: 900, y: -200 });
    expect(byId.c).toMatchObject({ x: 400 + COLUMN_GAP, y: LABEL_HEIGHT });
  });
});
