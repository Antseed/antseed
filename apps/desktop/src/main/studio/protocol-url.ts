import { isStudioProjectId, normalizeStudioPath, STUDIO_SCHEME, STUDIO_URL_HOST } from '../../shared/studio.js';

export function parseStudioUrl(rawUrl: string): { projectId: string; filePath: string } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${STUDIO_SCHEME}:` || url.hostname !== STUDIO_URL_HOST) return null;
  let segments: string[];
  try {
    segments = url.pathname.replace(/^\/+/, '').split('/').map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  const [projectId, ...rest] = segments;
  const decoded = rest.join('/');
  const filePath = normalizeStudioPath(decoded);
  if (!isStudioProjectId(projectId) || !filePath || filePath !== decoded || filePath.split('/').length !== rest.length) return null;
  return { projectId, filePath };
}
