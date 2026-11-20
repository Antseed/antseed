import type { StudioLibraryItem, StudioTrack } from './studio-track.js';

export const STUDIO_SCHEME = 'antseed-studio';
export const STUDIO_URL_HOST = 'project';

export const STUDIO_PROJECT_FILE = 'project.json';
export const STUDIO_BOARD_FILE = 'board.json';

export const STUDIO_SHOT_STATUSES = ['planned', 'still', 'approved', 'rendering', 'done', 'failed'] as const;
export type StudioShotStatus = (typeof STUDIO_SHOT_STATUSES)[number];

export type StudioShot = {
  id: string;
  title: string;
  description: string;
  durationSeconds: number | null;
  status: StudioShotStatus;
  still: string | null;
  clip: string | null;
  note: string;
  alternatives?: string[];
};

export type StudioCostLine = { label: string; detail: string; usd: number };

export type StudioEstimate = {
  approved: boolean;
  lines: StudioCostLine[];
  totalUsd: number;
};

export type StudioBoard = {
  kind: 'video' | 'pictures';
  brief: string;
  aspectRatio: string;
  style: string;
  shots: StudioShot[];
  estimate: StudioEstimate | null;
  spent: StudioCostLine[];
  final: string | null;
};

export type StudioProjectSummary = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  conversationId: string | null;
  shotCount: number;
  cover: { path: string; version: number } | null;
};

export type StudioProjectDetail = {
  project: StudioProjectSummary;
  folder: string;
  board: StudioBoard;
  boardError: string | null;
  /** The track editor's state; null for a storyboard made before the track editor. */
  track: StudioTrack | null;
  trackError: string | null;
  library: StudioLibraryItem[];
  /** Short notes about the agent's deliveries that could not be applied. */
  notices: string[];
  canUndo: boolean;
  files: Record<string, number>;
  /** Whether ffmpeg and ffprobe run on this computer: trimming a clip and export need them. */
  mediaTools: boolean;
};

export const STUDIO_MEDIA_TOOLS_MISSING = 'End clip here and Export need ffmpeg and ffprobe on this computer. Install them, then restart the app.';

const MAX_SHOTS = 60;
const MAX_USD = 100_000;

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'webm']);

export function emptyStudioBoard(): StudioBoard {
  return { kind: 'video', brief: '', aspectRatio: '', style: '', shots: [], estimate: null, spent: [], final: null };
}

export function isStudioProjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

export function normalizeStudioPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 300 || text.includes('\\') || text.includes('\0')) return null;
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) return null;
  const segments = text.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

export function studioMediaKind(filePath: string): 'image' | 'video' | null {
  const extension = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return null;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function usd(value: unknown): number | null {
  const amount = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(amount) && amount >= 0 && amount <= MAX_USD ? amount : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function mediaPath(value: unknown, kind: 'image' | 'video'): string | null {
  const normalized = normalizeStudioPath(value);
  return normalized && studioMediaKind(normalized) === kind ? normalized : null;
}

/** Every line is kept: totals are their sum, so dropping one would hide money paid or quoted. */
function costLines(value: unknown): StudioCostLine[] {
  if (!Array.isArray(value)) return [];
  const lines: StudioCostLine[] = [];
  for (const entry of value) {
    const item = record(entry);
    const amount = usd(item?.['usd']);
    const label = text(item?.['label'], 120);
    if (!item || amount === null || !label) continue;
    lines.push({ label, detail: text(item['detail'], 200), usd: amount });
  }
  return lines;
}

export function sumStudioCost(lines: readonly StudioCostLine[]): number {
  return Math.round(lines.reduce((total, line) => total + line.usd, 0) * 1e6) / 1e6;
}

function parseShot(value: unknown, index: number): StudioShot | null {
  const item = record(value);
  if (!item) return null;
  const duration = typeof item['durationSeconds'] === 'number' ? item['durationSeconds'] : NaN;
  const status = STUDIO_SHOT_STATUSES.find((candidate) => candidate === item['status']) ?? 'planned';
  return {
    id: text(item['id'], 24) || String(index + 1).padStart(2, '0'),
    title: text(item['title'], 200),
    description: text(item['description'], 2000),
    durationSeconds: Number.isFinite(duration) && duration > 0 && duration <= 600 ? duration : null,
    status,
    still: mediaPath(item['still'], 'image'),
    clip: mediaPath(item['clip'], 'video'),
    note: text(item['note'], 500),
    ...(Array.isArray(item['alternatives']) ? { alternatives: item['alternatives'].slice(0,64).filter((p): p is string => typeof p === 'string' && !!normalizeStudioPath(p) && !!studioMediaKind(p)) } : {}),
  };
}

function parseEstimate(value: unknown): StudioEstimate | null {
  const item = record(value);
  if (!item) return null;
  const lines = costLines(item['lines']);
  const total = usd(item['totalUsd']);
  if (lines.length === 0 && total === null) return null;
  return { approved: item['approved'] === true, lines, totalUsd: lines.length > 0 ? sumStudioCost(lines) : total! };
}

export function parseStudioBoard(raw: unknown): StudioBoard {
  const board = record(raw);
  if (!board) return emptyStudioBoard();
  const shots = Array.isArray(board['shots']) ? board['shots'] : [];
  return {
    kind: board['kind'] === 'pictures' ? 'pictures' : 'video',
    brief: text(board['brief'], 4000),
    aspectRatio: text(board['aspectRatio'], 16),
    style: text(board['style'], 600),
    shots: shots.slice(0, MAX_SHOTS).map(parseShot).filter((shot): shot is StudioShot => shot !== null),
    estimate: parseEstimate(board['estimate']),
    spent: costLines(board['spent']),
    final: mediaPath(board['final'], 'video'),
  };
}

export function studioBoardFiles(board: StudioBoard): string[] {
  const files = board.shots.flatMap((shot) => [shot.still, shot.clip]);
  return [...new Set([...files, board.final].filter((file): file is string => file !== null))];
}
