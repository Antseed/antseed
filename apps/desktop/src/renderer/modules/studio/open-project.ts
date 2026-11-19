import { useSyncExternalStore } from 'react';
import type { StudioProjectSummary } from '../../../shared/studio.js';

/** The Studio project on screen, kept for the app's lifetime so Studio reopens where it was. */
let openId: string | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openStudioProject(id: string | null): void {
  if (openId === id) return;
  openId = id;
  for (const listener of listeners) listener();
}

export function useOpenStudioProject(): string | null {
  return useSyncExternalStore(subscribe, () => openId, () => openId);
}

/** The project whose chat this is, so the sidebar opens it in Studio rather than in Chat. */
export function studioProjectForConversation(projects: readonly StudioProjectSummary[] | null, conversationId: string): string | null {
  return projects?.find((project) => project.conversationId === conversationId)?.id ?? null;
}
