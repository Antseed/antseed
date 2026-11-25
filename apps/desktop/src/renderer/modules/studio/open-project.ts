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

export type ConversationRoute = {
  /** The project list read so far. */
  known: readonly StudioProjectSummary[] | null;
  reload: () => Promise<readonly StudioProjectSummary[] | null>;
  /** False once the user has made a newer choice. */
  current: () => boolean;
  activate: (conversationId: string) => void;
  openProject: (projectId: string) => void;
  selectView: (view: 'studio' | 'chat') => void;
};

/**
 * Opens a chat picked in the sidebar where it belongs: in its Studio project,
 * or in Chat. The chat becomes active only once that is known, so the project
 * on screen never talks to it while the list is read again.
 */
export async function openConversationWhereItBelongs(conversationId: string, route: ConversationRoute): Promise<void> {
  let projects = route.known;
  // A project's chat may be newer than the list read so far: read it again before opening plain Chat.
  if (!studioProjectForConversation(projects, conversationId)) projects = await route.reload().catch(() => null);
  if (!route.current()) return;
  const project = studioProjectForConversation(projects, conversationId);
  if (project) route.openProject(project);
  route.activate(conversationId);
  route.selectView(project ? 'studio' : 'chat');
}

/** A request held while its edit is saved: `still` says whether it may go out now, `send` sends it only then. */
export type HeldSend = { still: () => boolean; send: (text: string) => void };

/**
 * Holds a request that saves an edit first. `where` is the chat the project
 * on screen talks to (null while its chat is not made yet), or false when the
 * project is not on screen. The request goes out only if the same project
 * still talks to the same chat once the edit is saved.
 */
export function holdSend(where: () => string | null | false, send: (text: string) => void): HeldSend {
  const at = where();
  const still = () => at !== false && where() === at;
  return { still, send: (text) => { if (still()) send(text); } };
}

/**
 * The user's choices in order: each chat picked, each New Chat and each change
 * of view is newer. `turn` starts a choice and returns whether it is still the
 * latest, so a project lookup still pending for an older one is dropped.
 */
export function navigationTurns(): { advance: () => void; turn: () => () => boolean } {
  let latest = 0;
  return {
    advance: () => { latest += 1; },
    turn: () => {
      const at = ++latest;
      return () => at === latest;
    },
  };
}
