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
        if (!result.data.boardError) lastReadable = result.data;
        return result.data.boardError && lastReadable ? { ...lastReadable, boardError: result.data.boardError } : result.data;
      },
    });
    projectResources.set(id, resource);
  }
  return resource;
}
