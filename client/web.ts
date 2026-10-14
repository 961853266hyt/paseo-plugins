import { Platform } from "react-native";
import type { SuggestionEntry, SuggestionStore } from "./suggestion-store";

/*
 * Paseo has no plugin API for the composer, so on web and desktop this module reaches the
 * composer through the DOM, the way PromptKit (MIT, github.com/hungcuong9125/paseo-prompt-kit)
 * does. Selectors come from the app source: `dataSet={COMPOSER_INPUT_DATASET}` on the text field
 * in packages/app/src/composer/input/input.tsx. When anything here cannot be proven, it changes
 * nothing and reports the composer as unavailable, so the timeline card takes over.
 */

const COMPOSER_INPUT_SELECTOR = "textarea[data-composer-input]";

// This plugin typechecks without the DOM library. Declare only what this module uses.
interface ComposerField {
  value: string;
  readonly isConnected: boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  setSelectionRange(start: number, end: number): void;
  dispatchEvent(event: object): boolean;
}
interface KeyDownEvent {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  target: unknown;
  preventDefault(): void;
  stopImmediatePropagation(): void;
}
interface InputLikeEvent {
  target: unknown;
}
declare const document: {
  body: object;
  querySelectorAll(selector: string): ArrayLike<ComposerField>;
  addEventListener(type: "keydown", listener: (event: KeyDownEvent) => void, capture: boolean): void;
  addEventListener(type: "input", listener: (event: InputLikeEvent) => void, capture: boolean): void;
  removeEventListener(type: "keydown", listener: (event: KeyDownEvent) => void, capture: boolean): void;
  removeEventListener(type: "input", listener: (event: InputLikeEvent) => void, capture: boolean): void;
};
declare const MutationObserver: new (callback: () => void) => {
  observe(
    target: object,
    options: { childList: boolean; subtree: boolean; attributes: boolean; attributeFilter: string[] },
  ): void;
  disconnect(): void;
};
declare const InputEvent: new (type: "input", init: { bubbles: boolean }) => object;
declare function requestAnimationFrame(callback: () => void): number;
declare function cancelAnimationFrame(handle: number): void;

export const isComposerBridgeSupported = Platform.OS === "web";

interface OwnedPlaceholder {
  original: string | null;
  applied: string;
}

/**
 * Shows each agent's suggestion as its composer placeholder and accepts it with Tab. Phone-sized
 * layouts keep the app's placeholder; the timeline card is the only place the suggestion shows.
 */
export function startComposerBridge(store: SuggestionStore): () => void {
  if (!isComposerBridgeSupported) return () => {};

  const owned = new Map<ComposerField, OwnedPlaceholder>();
  let frame: number | null = null;

  function schedule(): void {
    if (frame === null) frame = requestAnimationFrame(sync);
  }

  function sync(): void {
    frame = null;
    if (store.isCompact()) {
      for (const field of Array.from(owned.keys())) restorePlaceholder(field);
      return;
    }
    const reached = new Set<string>();
    for (const field of Array.from(document.querySelectorAll(COMPOSER_INPUT_SELECTOR))) {
      const agentId = agentIdOf(field);
      const entry = agentId ? store.get(agentId) : undefined;
      if (agentId && entry) {
        showPlaceholder(field, entry.text);
        reached.add(agentId);
      } else {
        restorePlaceholder(field);
      }
    }
    for (const field of owned.keys()) {
      if (!field.isConnected) owned.delete(field);
    }
    for (const agentId of store.entries().keys()) {
      store.setComposerState(agentId, reached.has(agentId) ? "shown" : "unavailable");
    }
  }

  function showPlaceholder(field: ComposerField, text: string): void {
    const current = field.getAttribute("placeholder");
    if (current === text) return;
    const ownership = owned.get(field);
    // Anything other than our own text is the app's placeholder, possibly re-rendered.
    const original = ownership && current === ownership.applied ? ownership.original : current;
    owned.set(field, { original, applied: text });
    field.setAttribute("placeholder", text);
  }

  function restorePlaceholder(field: ComposerField): void {
    const ownership = owned.get(field);
    if (!ownership) return;
    owned.delete(field);
    if (field.getAttribute("placeholder") !== ownership.applied) return;
    if (ownership.original === null) field.removeAttribute("placeholder");
    else field.setAttribute("placeholder", ownership.original);
  }

  function onKeyDown(event: KeyDownEvent): void {
    const hasModifier = event.shiftKey || event.ctrlKey || event.metaKey || event.altKey;
    if (event.key !== "Tab" || hasModifier || event.isComposing) return;
    const accepted = acceptableSuggestion(event.target);
    if (!accepted) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const { field, agentId, entry } = accepted;
    setNativeValue(field, entry.text);
    field.dispatchEvent(new InputEvent("input", { bubbles: true }));
    field.setSelectionRange(entry.text.length, entry.text.length);
    store.remove(agentId);
  }

  function acceptableSuggestion(
    target: unknown,
  ): { field: ComposerField; agentId: string; entry: SuggestionEntry } | null {
    const field = asComposerField(target);
    if (!field || field.value.length > 0 || store.isCompact()) return null;
    const agentId = agentIdOf(field);
    const entry = agentId ? store.get(agentId) : undefined;
    return agentId && entry ? { field, agentId, entry } : null;
  }

  // Typing replaces the suggestion, as in Claude Code.
  function onInput(event: InputLikeEvent): void {
    const field = asComposerField(event.target);
    if (!field || field.value.length === 0) return;
    const agentId = agentIdOf(field);
    if (agentId) store.remove(agentId);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["placeholder"],
  });
  const unsubscribe = store.subscribe(schedule);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("input", onInput, true);
  schedule();

  return () => {
    unsubscribe();
    observer.disconnect();
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("input", onInput, true);
    if (frame !== null) cancelAnimationFrame(frame);
    for (const field of Array.from(owned.keys())) restorePlaceholder(field);
  };
}

function asComposerField(target: unknown): ComposerField | null {
  if (typeof target !== "object" || target === null) return null;
  const matches = (target as { matches?: unknown }).matches;
  if (typeof matches !== "function") return null;
  return matches.call(target, COMPOSER_INPUT_SELECTOR) === true ? (target as ComposerField) : null;
}

interface FiberLike {
  return: FiberLike | null;
  alternate: FiberLike | null;
  memoizedProps: Record<string, unknown> | null;
}

/**
 * The composer receives `agentId` and `workspaceId` as props, so the nearest fiber carrying both
 * names the agent. A fiber whose alternate disagrees is mid-update and proves nothing.
 */
function agentIdOf(field: ComposerField): string | null {
  const key = Object.keys(field).find((name) => name.startsWith("__reactFiber$"));
  if (!key) return null;
  let node = (field as unknown as Record<string, FiberLike | null>)[key] ?? null;
  for (; node; node = node.return) {
    const props = node.memoizedProps;
    if (!props || typeof props.agentId !== "string" || !("workspaceId" in props)) continue;
    const alternate = node.alternate?.memoizedProps;
    if (alternate && alternate.agentId !== props.agentId) return null;
    return props.agentId;
  }
  return null;
}

/**
 * React tracks the value it last rendered, so a plain assignment is invisible to `onChange`.
 * The prototype's native setter updates the field without that tracking, and the bubbling
 * `input` event is what React listens to.
 */
function setNativeValue(field: ComposerField, value: string): void {
  let prototype = Object.getPrototypeOf(field) as object | null;
  while (prototype) {
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) {
      setter.call(field, value);
      return;
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  field.value = value;
}
