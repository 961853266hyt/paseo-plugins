type Listener = (agentId: string) => void;

const listeners = new Set<Listener>();

/** A side question was just asked from this client: open thread views show it without waiting. */
export function announceAsked(agentId: string): void {
  for (const listener of listeners) listener(agentId);
}

export function onAsked(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
