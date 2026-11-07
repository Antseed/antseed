// ── Chat event bus ──
// The pi chat engine reports everything (stream deltas, tool approvals,
// completions) through the sendToRenderer callback it was given. main.ts
// tees that callback into this bus so non-renderer surfaces — currently the
// Telegram bridge — can observe the same per-conversation event flow without
// the engine knowing they exist.

export type ChatEventListener = (channel: string, payload: unknown) => void;

const listeners = new Set<ChatEventListener>();

export function emitChatEvent(channel: string, payload: unknown): void {
  for (const listener of listeners) {
    try {
      listener(channel, payload);
    } catch {
      // A broken observer must never break the renderer event path.
    }
  }
}

export function onChatEvents(listener: ChatEventListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
