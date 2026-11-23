import type { StudioProjectDetail, StudioProjectSummary } from '../../../shared/studio.js';
import { createCachedResource, type CachedResource } from '../app/cached-resource';

export const studioProjectsResource = createCachedResource<StudioProjectSummary[]>({
  pollMs: 5_000,
  async load() {
    const result = await window.antseedDesktop?.studioList?.();
    if (!result?.ok) throw new Error(result?.error ?? 'Could not read your Studio projects');
    return result.data ?? [];
  },
});

const projectResources = new Map<string, CachedResource<StudioProjectDetail>>();

export function studioProjectResource(id: string): CachedResource<StudioProjectDetail> {
  let resource = projectResources.get(id);
  if (!resource) {
    let lastReadable: StudioProjectDetail | null = null;
    resource = createCachedResource<StudioProjectDetail>({
      pollMs: 1_500,
      async load() {
        const result = await window.antseedDesktop?.studioGet?.(id);
        if (!result?.ok || !result.data) throw new Error(result?.error ?? 'Could not read this project');
        const shown = keepReadable(lastReadable, result.data);
        if (!result.data.boardError && !result.data.trackError) lastReadable = result.data;
        return shown;
      },
    });
    projectResources.set(id, resource);
  }
  return resource;
}

/**
 * What a poll shows: the project as read, or, when its board or track could not be read, the last
 * project read whole with the current errors, so a bad read never empties the storyboard on screen.
 */
export function keepReadable(last: StudioProjectDetail | null, next: StudioProjectDetail): StudioProjectDetail {
  if ((!next.boardError && !next.trackError) || !last) return next;
  return { ...last, boardError: next.boardError, trackError: next.trackError };
}
