import {
  STUDIO_SCHEME,
  STUDIO_URL_HOST,
  sumStudioCost,
  type StudioBoard,
  type StudioShot,
  type StudioShotStatus,
} from '../../../shared/studio.js';

export function studioFileUrl(projectId: string, filePath: string, version?: number): string {
  const encoded = filePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `${STUDIO_SCHEME}://${STUDIO_URL_HOST}/${encodeURIComponent(projectId)}/${encoded}${version ? `?v=${String(version)}` : ''}`;
}

export function studioMimeType(filePath: string): string {
  const extension = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
  if (extension === 'mp4' || extension === 'm4v') return 'video/mp4';
  if (extension === 'mov') return 'video/quicktime';
  if (extension === 'webm') return 'video/webm';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  return `image/${extension}`;
}

export function formatStudioUsd(value: number): string {
  if (value > 0 && value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
}

export type ShotBadge = { label: string; tone: 'neutral' | 'success' | 'warning' };

const SHOT_LABELS: Record<StudioShotStatus, ShotBadge> = {
  planned: { label: 'Planned', tone: 'neutral' },
  still: { label: 'Review still', tone: 'neutral' },
  approved: { label: 'Still approved', tone: 'neutral' },
  rendering: { label: 'Making video', tone: 'neutral' },
  done: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'warning' },
};

export function shotBadge(status: StudioShotStatus): ShotBadge {
  return SHOT_LABELS[status];
}

export function shotMedia(shot: StudioShot, files: Record<string, number>): { kind: 'video' | 'image'; path: string; version: number; poster?: { path: string; version: number } } | null {
  const still = shot.still !== null && files[shot.still] !== undefined ? { path: shot.still, version: files[shot.still]! } : null;
  if (shot.clip !== null && files[shot.clip] !== undefined) {
    return { kind: 'video', path: shot.clip, version: files[shot.clip]!, ...(still ? { poster: still } : {}) };
  }
  return still ? { kind: 'image', ...still } : null;
}

export type StudioMoney = {
  estimateUsd: number | null;
  approved: boolean;
  spentUsd: number;
  over: boolean;
};

export function studioMoney(board: StudioBoard): StudioMoney {
  const spentUsd = sumStudioCost(board.spent);
  const estimateUsd = board.estimate ? board.estimate.totalUsd : null;
  return {
    estimateUsd,
    approved: board.estimate?.approved ?? false,
    spentUsd,
    over: estimateUsd !== null && spentUsd > estimateUsd + 0.004,
  };
}

export function boardProgress(board: StudioBoard): string {
  const total = board.shots.length;
  if (total === 0) return 'No shots yet';
  const noun = board.kind === 'pictures' ? 'picture' : 'shot';
  const count = `${String(total)} ${noun}${total === 1 ? '' : 's'}`;
  const done = board.shots.filter((shot) => shot.status === 'done').length;
  if (board.kind === 'video' && done > 0) return `${count} · ${String(done)} with video`;
  const stills = board.shots.filter((shot) => shot.still !== null).length;
  return stills > 0 ? `${count} · ${String(stills)} with a still` : count;
}

export function totalSeconds(board: StudioBoard): number {
  return board.shots.reduce((sum, shot) => sum + (shot.durationSeconds ?? 0), 0);
}
