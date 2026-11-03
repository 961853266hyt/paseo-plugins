import { z } from "zod";
import { commentStatusSchema, rectSchema } from "./design";

/** Every message carries this marker, so the canvas ignores whatever else a design posts. */
export const PROTOCOL_MARK = "design-canvas/1";

export const canvasModeSchema = z.enum(["browse", "comment"]);
export type CanvasMode = z.infer<typeof canvasModeSchema>;

/** What the runtime reports about a picked element; the canvas adds the artboard id. */
export const pickedSchema = z.object({
  dcId: z.string().max(120).optional(),
  path: z.string().max(2000),
  tag: z.string().max(40),
  text: z.string().max(200),
  html: z.string().max(1200),
  /** In page coordinates. */
  rect: rectSchema,
});
export type Picked = z.infer<typeof pickedSchema>;

export const pinSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  status: commentStatusSchema,
  dcId: z.string().optional(),
  path: z.string(),
  rect: rectSchema,
});
export type Pin = z.infer<typeof pinSchema>;

export type ToRuntime =
  | { mark: typeof PROTOCOL_MARK; type: "mode"; mode: CanvasMode }
  | { mark: typeof PROTOCOL_MARK; type: "pins"; pins: Pin[]; selectedId: string | null }
  | { mark: typeof PROTOCOL_MARK; type: "guides"; on: boolean }
  /** The canvas zoom, so pins and outlines keep their size on screen. */
  | { mark: typeof PROTOCOL_MARK; type: "zoom"; zoom: number }
  | { mark: typeof PROTOCOL_MARK; type: "clear-selection" }
  /** The pointer is over the canvas, not this page; iframes do not always hear it leave. */
  | { mark: typeof PROTOCOL_MARK; type: "clear-hover" };

/** A message to the runtime before the marker is added. */
export type RuntimeCommand = ToRuntime extends infer Message
  ? Message extends ToRuntime
    ? Omit<Message, "mark">
    : never
  : never;

const base = { mark: z.literal(PROTOCOL_MARK) };

/** Messages from a design's iframe. The design's own scripts can post too, so all of it is validated. */
export const fromRuntimeSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("ready"), height: z.number() }),
  z.object({ ...base, type: z.literal("size"), height: z.number() }),
  /** `viewport` is the element's box in the iframe's viewport, for placing the comment box. */
  z.object({ ...base, type: z.literal("pick"), picked: pickedSchema, viewport: rectSchema }),
  z.object({ ...base, type: z.literal("pin"), id: z.string(), viewport: rectSchema }),
  z.object({
    ...base,
    type: z.literal("wheel"),
    deltaX: z.number(),
    deltaY: z.number(),
    zoom: z.boolean(),
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    ...base,
    type: z.literal("key"),
    key: z.string().max(20),
    meta: z.boolean(),
    shift: z.boolean(),
  }),
  /** A click on a link to another page of the design, e.g. `checkout.html`. */
  z.object({ ...base, type: z.literal("navigate"), file: z.string().max(200) }),
]);
export type FromRuntime = z.infer<typeof fromRuntimeSchema>;
