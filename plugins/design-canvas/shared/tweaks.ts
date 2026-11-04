import { z } from "zod";

/**
 * Tweaks are the controls an agent declares in design.json: each one drives a CSS custom property,
 * so the canvas can change it live without a model call. Toggles and selects pick between CSS
 * values too (`display: var(--show-badge)`), which keeps every tweak expressible in one stylesheet.
 */

export const TWEAKS_FILE = "tweaks.json";
export const TWEAKS_CSS = "tweaks.css";

const cssVarSchema = z.string().regex(/^--[A-Za-z0-9_-]{1,60}$/, "A CSS custom property such as --accent");

/** Written into tweaks.css, so nothing that could end the declaration or the rule. */
export const cssValueSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^;{}<>\\\r\n]*$/, "A CSS value without ; { } < > or backslashes");

const UNITS = ["", "px", "rem", "em", "%", "vw", "vh", "deg", "ms", "s", "fr"] as const;

const base = {
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/, "Lowercase letters, digits, - and _"),
  label: z.string().min(1).max(60),
  var: cssVarSchema,
};

export const tweakSchema = z
  .discriminatedUnion("type", [
    z.object({ ...base, type: z.literal("color"), default: cssValueSchema }),
    z.object({
      ...base,
      type: z.literal("range"),
      min: z.number(),
      max: z.number(),
      step: z.number().positive().optional(),
      unit: z.enum(UNITS).optional(),
      default: z.number(),
    }),
    z.object({ ...base, type: z.literal("toggle"), on: cssValueSchema, off: cssValueSchema, default: z.boolean() }),
    z.object({
      ...base,
      type: z.literal("select"),
      options: z.array(z.object({ label: z.string().min(1).max(40), value: cssValueSchema })).min(2).max(12),
      default: cssValueSchema,
    }),
  ])
  .superRefine((tweak, ctx) => {
    if (tweak.type === "range") {
      if (tweak.min >= tweak.max) ctx.addIssue({ code: "custom", path: ["max"], message: "max must be above min" });
      else if (tweak.default < tweak.min || tweak.default > tweak.max) {
        ctx.addIssue({ code: "custom", path: ["default"], message: `default must be between ${tweak.min} and ${tweak.max}` });
      }
    }
    if (tweak.type === "select" && !tweak.options.some((option) => option.value === tweak.default)) {
      ctx.addIssue({ code: "custom", path: ["default"], message: "default must be one of the options' values" });
    }
  });
export type Tweak = z.infer<typeof tweakSchema>;

export const tweaksListSchema = z
  .array(tweakSchema)
  .max(40)
  .superRefine((tweaks, ctx) => {
    const ids = new Set<string>();
    const vars = new Set<string>();
    tweaks.forEach((tweak, index) => {
      if (ids.has(tweak.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: `Duplicate tweak id ${tweak.id}` });
      if (vars.has(tweak.var)) ctx.addIssue({ code: "custom", path: [index, "var"], message: `Two tweaks set ${tweak.var}` });
      ids.add(tweak.id);
      vars.add(tweak.var);
    });
  });

export const tweakValueSchema = z.union([z.string().max(200), z.number(), z.boolean()]);
export type TweakValue = z.infer<typeof tweakValueSchema>;
export type TweakValues = Record<string, TweakValue>;

export const tweaksFileSchema = z.object({
  version: z.literal(1),
  /** Only the tweaks the user moved away from their default. */
  values: z.record(z.string(), tweakValueSchema),
});
export type TweaksFile = z.infer<typeof tweaksFileSchema>;

/** The value if it fits the tweak, else null. Ranges are clamped and snapped to their step. */
export function checkValue(tweak: Tweak, value: unknown): TweakValue | null {
  switch (tweak.type) {
    case "color":
      return cssValueSchema.safeParse(value).success ? (value as string) : null;
    case "range": {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      const clamped = Math.min(tweak.max, Math.max(tweak.min, value));
      if (!tweak.step) return clamped;
      const snapped = tweak.min + Math.round((clamped - tweak.min) / tweak.step) * tweak.step;
      return Number(Math.min(tweak.max, snapped).toFixed(6));
    }
    case "toggle":
      return typeof value === "boolean" ? value : null;
    case "select":
      return typeof value === "string" && tweak.options.some((option) => option.value === value) ? value : null;
  }
}

export function effectiveValue(tweak: Tweak, values: TweakValues): TweakValue {
  const value = values[tweak.id];
  return value === undefined ? tweak.default : (checkValue(tweak, value) ?? tweak.default);
}

/** The CSS value a tweak's variable gets. */
export function cssValue(tweak: Tweak, value: TweakValue): string {
  switch (tweak.type) {
    case "range":
      return `${value}${tweak.unit ?? ""}`;
    case "toggle":
      return value ? tweak.on : tweak.off;
    default:
      return String(value);
  }
}

/** Keeps the values that fit their tweak and differ from its default. */
export function prune(tweaks: readonly Tweak[], values: TweakValues): TweakValues {
  const out: TweakValues = {};
  for (const tweak of tweaks) {
    if (!(tweak.id in values)) continue;
    const value = checkValue(tweak, values[tweak.id]);
    if (value !== null && value !== tweak.default) out[tweak.id] = value;
  }
  return out;
}

/** Every tweak's variable with its value, or "" where it is at its default and the page's own CSS applies. */
export function overrides(tweaks: readonly Tweak[], values: TweakValues): Record<string, string> {
  const pruned = prune(tweaks, values);
  return Object.fromEntries(tweaks.map((tweak) => [tweak.var, tweak.id in pruned ? cssValue(tweak, pruned[tweak.id]!) : ""]));
}

export function renderTweaksCss(tweaks: readonly Tweak[], values: TweakValues): string {
  const lines = Object.entries(overrides(tweaks, values))
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `  ${name}: ${value};`);
  const header = "/* Written by the Design canvas from tweaks.json; change the values on the canvas, not here. */\n";
  return lines.length ? `${header}:root {\n${lines.join("\n")}\n}\n` : header;
}

/** A value as the panel shows it. */
export function formatValue(tweak: Tweak, value: TweakValue): string {
  if (tweak.type === "select") return tweak.options.find((option) => option.value === value)?.label ?? String(value);
  if (tweak.type === "toggle") return value ? "on" : "off";
  return cssValue(tweak, value);
}

/** Whether a page's HTML (with its stylesheets inlined) reads the variable anywhere. */
export function usesVariable(html: string, name: string): boolean {
  return new RegExp(`var\\(\\s*${name}\\s*[,)]`).test(html);
}
