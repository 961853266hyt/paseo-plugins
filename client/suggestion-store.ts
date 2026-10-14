/**
 * Where the app shows each agent's suggestion. The timeline renderer feeds it, including whether
 * the app has a phone-sized layout; the web composer bridge reads it to set the composer
 * placeholder and reports back whether that worked.
 */
export type ComposerState = "pending" | "shown" | "unavailable";

export interface SuggestionEntry {
  text: string;
  /** Row timestamp: a renderer never lets an older row override a newer one. */
  at: number;
  composer: ComposerState;
}

export interface CardPlacement {
  bridgeSupported: boolean;
  /** Phone-sized layout, where Paseo itself treats the web keyboard as a touch keyboard. */
  compact: boolean;
  composer: ComposerState;
}

/**
 * The card is the tap target. It is needed wherever Tab cannot accept the placeholder: native
 * apps, phone-sized web (PWA or mobile browser), and any composer the bridge could not reach.
 * Phone-sized web shows the card alone, since a long placeholder would collide with the app's
 * focus hint and repeat what the card already says.
 */
export function needsCard({ bridgeSupported, compact, composer }: CardPlacement): boolean {
  return !bridgeSupported || compact || composer === "unavailable";
}

export interface SuggestionStore {
  get(agentId: string): SuggestionEntry | undefined;
  entries(): ReadonlyMap<string, SuggestionEntry>;
  offer(agentId: string, text: string, at: number): void;
  /** A dismissed row at `at` retires every suggestion it is not older than. */
  retire(agentId: string, at: number): void;
  remove(agentId: string): void;
  setComposerState(agentId: string, composer: ComposerState): void;
  /** Phone-sized layout: the composer placeholder stays the app's own and Tab is left alone. */
  isCompact(): boolean;
  setCompact(compact: boolean): void;
  subscribe(listener: () => void): () => void;
}

export function createSuggestionStore(): SuggestionStore {
  const suggestions = new Map<string, SuggestionEntry>();
  const listeners = new Set<() => void>();
  let compact = false;

  function publish(): void {
    for (const listener of listeners) listener();
  }

  return {
    get: (agentId) => suggestions.get(agentId),
    entries: () => suggestions,
    offer(agentId, text, at) {
      const current = suggestions.get(agentId);
      if (current && current.at > at) return;
      if (current && current.at === at && current.text === text) return;
      suggestions.set(agentId, { text, at, composer: "pending" });
      publish();
    },
    retire(agentId, at) {
      const current = suggestions.get(agentId);
      if (!current || current.at > at) return;
      suggestions.delete(agentId);
      publish();
    },
    remove(agentId) {
      if (suggestions.delete(agentId)) publish();
    },
    setComposerState(agentId, composer) {
      const current = suggestions.get(agentId);
      if (!current || current.composer === composer) return;
      suggestions.set(agentId, { ...current, composer });
      publish();
    },
    isCompact: () => compact,
    setCompact(next) {
      if (compact === next) return;
      compact = next;
      publish();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
