import { normalizeStudioPath, studioMediaKind, type StudioBoard, type StudioCostLine } from './studio.js';

/**
 * A Studio film is one track: anchor images in order, and a clip leaving each
 * anchor. A clip between two anchors ends in a Cut (hard cut to the next
 * anchor) or an Extend (the clip lands on the next anchor). The user decides
 * which for every boundary; nothing is assumed.
 *
 * The app is the only writer of track.json. The project agent reads it and
 * hands generated files and its edits back through deliveries/ (see
 * parseStudioDelivery).
 */
export const STUDIO_TRACK_FILE = 'track.json';
export const STUDIO_DELIVERIES_DIR = 'deliveries';

export type ClipEnd = 'cut' | 'extend';

export type ClipVersion = {
  file: string;
  /** The anchor image this version started from; null for a clip brought in from the library. */
  from: string | null;
  /** The image this version was made to land on; null when it had no end frame. */
  to: string | null;
  seconds: number | null;
  label: string;
  addedAt: number;
};

export type TrackClip = {
  id: string;
  plannedSeconds: number;
  prompt: string;
  /** What happens after this clip's end frame; null is undecided. */
  then: ClipEnd | null;
  /** The version in use (one of versions[].file). */
  use: string | null;
  /** Trimmed end, in seconds of the version in use. */
  end: number | null;
  /** The frame at `end`, saved when the clip was trimmed. */
  endFrame: string | null;
  versions: ClipVersion[];
  requestedAt: number | null;
};

export type TrackAnchor = {
  id: string;
  image: string | null;
  earlier: string[];
  /** Set when the image is a frame taken from a clip (a trim that extends). */
  from: { clip: string; at: number } | null;
  /** The shot's title on the storyboard, e.g. "Grand theft ladybug". */
  title: string;
  prompt: string;
  requestedAt: number | null;
  /** The clip leaving this anchor. Every anchor but the last has one. */
  clip: TrackClip | null;
};

export type TrackScene = { name: string; world: string };

export type StudioTrack = {
  version: 1;
  aspectRatio: string;
  anchors: TrackAnchor[];
  /** Keyed by the id of the scene's first anchor. */
  scenes: Record<string, TrackScene>;
  /** Original names of uploaded files. */
  labels: Record<string, string>;
  spent: StudioCostLine[];
  exports: string[];
  /** Every file the agent delivered, in order, so Undo can put them back. */
  delivered: DeliveryRecord[];
  nextId: number;
};

export type DeliveryRecord = { key: string; at: number; seconds: number | null; delivery: StudioDelivery };

export type StudioLibraryItem = {
  file: string;
  kind: 'image' | 'video';
  label: string;
  version: number;
  status: 'in-use' | 'earlier' | 'export' | 'unused';
};

export type TrackEdit =
  | { type: 'add-anchor'; index: number; file?: string | null; scene?: 'continue' | 'new'; title?: string; prompt?: string }
  | { type: 'set-image'; anchor: string; file: string }
  | { type: 'remove-anchor'; anchor: string }
  | { type: 'move-anchor'; anchor: string; to: number }
  | { type: 'clip'; anchor: string; plannedSeconds?: number; prompt?: string }
  | { type: 'anchor-prompt'; anchor: string; prompt: string }
  | { type: 'title'; anchor: string; title: string }
  | { type: 'then'; anchor: string; then: ClipEnd }
  | { type: 'trim'; anchor: string; end: number }
  | { type: 'reset-trim'; anchor: string }
  | { type: 'use-version'; anchor: string; file: string }
  | { type: 'add-version'; anchor: string; file: string }
  | { type: 'scene'; anchor: string; name: string; world: string }
  | { type: 'request'; clips: string[]; images: string[] }
  | { type: 'aspect'; aspectRatio: string }
  | { type: 'import'; anchor?: string; index?: number }
  | { type: 'convert' }
  | { type: 'export' }
  | { type: 'undo' }
  | { type: 'dismiss-notices' };

export const MIN_CLIP_SECONDS = 1;
export const MAX_CLIP_SECONDS = 30;
export const DEFAULT_CLIP_SECONDS = 5;
export const STUDIO_ASPECT_RATIOS = ['16:9', '9:16', '1:1'] as const;
const MAX_ANCHORS = 120;
const MAX_VERSIONS = 64;

export function emptyStudioTrack(): StudioTrack {
  return { version: 1, aspectRatio: '16:9', anchors: [], scenes: {}, labels: {}, spent: [], exports: [], delivered: [], nextId: 1 };
}

// ---------- parsing ----------

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function media(value: unknown, kind: 'image' | 'video'): string | null {
  const normalized = normalizeStudioPath(value);
  return normalized && studioMediaKind(normalized) === kind ? normalized : null;
}

function seconds(value: unknown, max = 600): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max ? value : null;
}

function stamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function id(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z][0-9]{1,6}$/.test(value) ? value : null;
}

function parseVersion(value: unknown): ClipVersion | null {
  const item = record(value);
  const file = media(item?.['file'], 'video');
  if (!item || !file) return null;
  return {
    file,
    from: media(item['from'], 'image'),
    to: media(item['to'], 'image'),
    seconds: seconds(item['seconds']),
    label: text(item['label'], 120),
    addedAt: stamp(item['addedAt']) ?? 0,
  };
}

function parseClip(value: unknown): TrackClip | null {
  const item = record(value);
  const clipId = id(item?.['id']);
  if (!item || !clipId) return null;
  const versions = Array.isArray(item['versions'])
    ? item['versions'].slice(0, MAX_VERSIONS).map(parseVersion).filter((version): version is ClipVersion => version !== null)
    : [];
  const use = media(item['use'], 'video');
  const planned = seconds(item['plannedSeconds'], MAX_CLIP_SECONDS);
  const inUse = use !== null && versions.some((version) => version.file === use) ? use : null;
  return {
    id: clipId,
    plannedSeconds: planned !== null && planned >= MIN_CLIP_SECONDS ? Math.round(planned) : DEFAULT_CLIP_SECONDS,
    prompt: text(item['prompt'], 2000),
    then: item['then'] === 'cut' || item['then'] === 'extend' ? item['then'] : null,
    use: inUse,
    end: inUse ? seconds(item['end']) : null,
    endFrame: inUse ? media(item['endFrame'], 'image') : null,
    versions,
    requestedAt: stamp(item['requestedAt']),
  };
}

function parseAnchor(value: unknown): TrackAnchor | null {
  const item = record(value);
  const anchorId = id(item?.['id']);
  if (!item || !anchorId) return null;
  const from = record(item['from']);
  const fromClip = id(from?.['clip']);
  const fromAt = seconds(from?.['at']);
  return {
    id: anchorId,
    image: media(item['image'], 'image'),
    earlier: Array.isArray(item['earlier'])
      ? [...new Set(item['earlier'].slice(0, MAX_VERSIONS).map((entry) => media(entry, 'image')).filter((entry): entry is string => entry !== null))]
      : [],
    from: fromClip && fromAt !== null ? { clip: fromClip, at: fromAt } : null,
    title: text(item['title'], 120),
    prompt: text(item['prompt'], 2000),
    requestedAt: stamp(item['requestedAt']),
    clip: parseClip(item['clip']),
  };
}

function parseCostLines(value: unknown): StudioCostLine[] {
  if (!Array.isArray(value)) return [];
  const lines: StudioCostLine[] = [];
  for (const entry of value.slice(-200)) {
    const item = record(entry);
    const usd = typeof item?.['usd'] === 'number' && Number.isFinite(item['usd']) && item['usd'] >= 0 && item['usd'] <= 10_000 ? item['usd'] : null;
    const label = text(item?.['label'], 120);
    if (usd !== null && label) lines.push({ label, detail: text(item?.['detail'], 200), usd });
  }
  return lines;
}

export function parseStudioTrack(raw: unknown): StudioTrack {
  const item = record(raw);
  if (!item) return emptyStudioTrack();
  const seen = new Set<string>();
  const anchors: TrackAnchor[] = [];
  for (const entry of Array.isArray(item['anchors']) ? item['anchors'].slice(0, MAX_ANCHORS) : []) {
    const anchor = parseAnchor(entry);
    if (!anchor || seen.has(anchor.id) || (anchor.clip && seen.has(anchor.clip.id))) continue;
    seen.add(anchor.id);
    if (anchor.clip) seen.add(anchor.clip.id);
    anchors.push(anchor);
  }
  // Every anchor but the last has a clip slot, so every gap can be filled.
  anchors.forEach((anchor, index) => {
    if (index < anchors.length - 1 && !anchor.clip) anchor.clip = blankClip(uniqueId('c', seen));
  });
  const scenes: Record<string, TrackScene> = {};
  for (const [key, value] of Object.entries(record(item['scenes']) ?? {})) {
    const scene = record(value);
    if (id(key) && scene) scenes[key] = { name: text(scene['name'], 120), world: text(scene['world'], 400) };
  }
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(record(item['labels']) ?? {})) {
    const file = normalizeStudioPath(key);
    if (file && typeof value === 'string' && value.trim()) labels[file] = value.trim().slice(0, 200);
  }
  const ratio = STUDIO_ASPECT_RATIOS.find((candidate) => candidate === item['aspectRatio']) ?? '16:9';
  const nextId = typeof item['nextId'] === 'number' && Number.isInteger(item['nextId']) && item['nextId'] > 0 ? item['nextId'] : 1;
  const highest = Math.max(0, ...[...seen].map((key) => Number(key.slice(1)) || 0));
  return {
    version: 1,
    aspectRatio: ratio,
    anchors,
    scenes,
    labels,
    spent: parseCostLines(item['spent']),
    exports: Array.isArray(item['exports'])
      ? item['exports'].slice(-50).map((entry) => media(entry, 'video')).filter((entry): entry is string => entry !== null)
      : [],
    delivered: Array.isArray(item['delivered']) ? item['delivered'].slice(-200).flatMap((entry): DeliveryRecord[] => {
      const recordEntry = record(entry);
      const delivery = parseStudioDelivery(recordEntry?.['delivery']);
      const key = text(recordEntry?.['key'], 200);
      return delivery && key ? [{ key, at: stamp(recordEntry?.['at']) ?? 0, seconds: seconds(recordEntry?.['seconds']), delivery }] : [];
    }) : [],
    nextId: Math.max(nextId, highest + 1),
  };
}

function uniqueId(prefix: 'a' | 'c', seen: Set<string>): string {
  let n = 1;
  while (seen.has(`${prefix}${String(n)}`)) n += 1;
  const value = `${prefix}${String(n)}`;
  seen.add(value);
  return value;
}

function blankClip(clipId: string): TrackClip {
  return { id: clipId, plannedSeconds: DEFAULT_CLIP_SECONDS, prompt: '', then: null, use: null, end: null, endFrame: null, versions: [], requestedAt: null };
}

// ---------- deliveries from the agent ----------

export type StudioDelivery =
  | { kind: 'clip'; clip: string; file: string; usd: number | null; model: string }
  | { kind: 'image'; anchor: string; file: string; usd: number | null; model: string };

/** The edits the agent may ask for when the user tells it in chat. Each one is undoable, like the user's own. */
export type StudioAgentEdit = Extract<TrackEdit, { type: 'title' | 'anchor-prompt' | 'clip' | 'then' | 'scene' | 'add-anchor' | 'move-anchor' | 'remove-anchor' | 'use-version' | 'aspect' }>;

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const AGENT_EDIT_TYPES = new Set(['title', 'anchor-prompt', 'clip', 'then', 'scene', 'add-anchor', 'move-anchor', 'remove-anchor', 'use-version', 'aspect']);
const USER_ONLY_EDIT_TYPES = new Set(['undo', 'export', 'trim', 'reset-trim', 'import', 'convert', 'request', 'set-image', 'add-version', 'dismiss-notices']);

/** Why an {"edit": ...} delivery was not taken, or null when it is not an edit at all. */
export function studioAgentEditProblem(raw: unknown): string | null {
  const item = record(record(raw)?.['edit']);
  if (!item) return null;
  const type = typeof item['type'] === 'string' ? item['type'].slice(0, 40) : '';
  if (!type) return 'asks for an edit without a type';
  if (USER_ONLY_EDIT_TYPES.has(type)) return `asks for "${type}", which only the user can do in the app`;
  if (!AGENT_EDIT_TYPES.has(type)) return `asks for "${type}", which is not an edit`;
  if ('anchor' in item && !id(item['anchor'])) return `names anchor ${JSON.stringify(item['anchor']).slice(0, 40)}, which is not an anchor id from track.json`;
  return `has a "${type}" edit with a missing or invalid field`;
}

/** An edit the agent announced in deliveries/<name>.json as {"edit": {...}}; anything else is refused. */
export function parseStudioAgentEdit(raw: unknown): StudioAgentEdit | null {
  const item = record(record(raw)?.['edit']);
  if (!item) return null;
  const anchor = id(item['anchor']);
  const optionalText = (key: string, max: number): string | undefined => (typeof item[key] === 'string' ? text(item[key], max) : undefined);
  switch (item['type']) {
    case 'title':
      return anchor && typeof item['title'] === 'string' ? { type: 'title', anchor, title: text(item['title'], 120) } : null;
    case 'anchor-prompt':
      return anchor && typeof item['prompt'] === 'string' ? { type: 'anchor-prompt', anchor, prompt: text(item['prompt'], 2000) } : null;
    case 'clip': {
      const plannedSeconds = finite(item['plannedSeconds']) ?? undefined;
      const prompt = optionalText('prompt', 2000);
      return anchor && (plannedSeconds !== undefined || prompt !== undefined) ? { type: 'clip', anchor, plannedSeconds, prompt } : null;
    }
    case 'then':
      return anchor && (item['then'] === 'cut' || item['then'] === 'extend') ? { type: 'then', anchor, then: item['then'] } : null;
    case 'scene':
      return anchor ? { type: 'scene', anchor, name: text(item['name'], 120), world: text(item['world'], 400) } : null;
    case 'add-anchor': {
      const index = finite(item['index']);
      const scene = item['scene'] === 'continue' || item['scene'] === 'new' ? item['scene'] : undefined;
      const file = item['file'] === undefined || item['file'] === null ? null : media(item['file'], 'image');
      if (index === null || (item['file'] !== undefined && item['file'] !== null && !file)) return null;
      return { type: 'add-anchor', index, file, scene, title: optionalText('title', 120), prompt: optionalText('prompt', 2000) };
    }
    case 'move-anchor': {
      const to = finite(item['to']);
      return anchor && to !== null ? { type: 'move-anchor', anchor, to } : null;
    }
    case 'remove-anchor':
      return anchor ? { type: 'remove-anchor', anchor } : null;
    case 'use-version': {
      const file = media(item['file'], 'video');
      return anchor && file ? { type: 'use-version', anchor, file } : null;
    }
    case 'aspect':
      return typeof item['aspectRatio'] === 'string' ? { type: 'aspect', aspectRatio: item['aspectRatio'] } : null;
    default:
      return null;
  }
}

/** A file the agent made, announced in deliveries/<name>.json. */
export function parseStudioDelivery(raw: unknown): StudioDelivery | null {
  const item = record(raw);
  if (!item) return null;
  const usd = typeof item['usd'] === 'number' && Number.isFinite(item['usd']) && item['usd'] >= 0 && item['usd'] <= 1000 ? item['usd'] : null;
  const model = text(item['model'], 120);
  const clip = id(item['clip']);
  const anchor = id(item['anchor']);
  if (item['kind'] !== undefined && item['kind'] !== (clip ? 'clip' : 'image')) return null;
  if (clip && !anchor) {
    const file = media(item['file'], 'video');
    return file ? { kind: 'clip', clip, file, usd, model } : null;
  }
  if (anchor && !clip) {
    const file = media(item['file'], 'image');
    return file ? { kind: 'image', anchor, file, usd, model } : null;
  }
  return null;
}

// ---------- names and derived state ----------

/** "3. Grand theft ladybug", or "3." while the shot has no title. */
export function shotTitle(track: StudioTrack, anchorId: string): string {
  const index = track.anchors.findIndex((anchor) => anchor.id === anchorId);
  const title = track.anchors[index]?.title ?? '';
  return `${String(index + 1)}.${title ? ` ${title}` : ''}`;
}

export function anchorName(track: StudioTrack, anchorId: string): string {
  return `Shot ${String(track.anchors.findIndex((anchor) => anchor.id === anchorId) + 1)}`;
}

export function clipName(track: StudioTrack, anchorId: string): string {
  const index = track.anchors.findIndex((anchor) => anchor.id === anchorId);
  return index < track.anchors.length - 1 ? `Clip ${String(index + 1)}→${String(index + 2)}` : `Clip after ${String(index + 1)}`;
}

export type ClipState = 'empty' | 'requested' | 'ready' | 'stale';

/** Whether the version in use was made from the images the track has now. */
export function clipIsStale(track: StudioTrack, index: number): boolean {
  const anchor = track.anchors[index];
  const clip = anchor?.clip;
  const version = clip?.versions.find((entry) => entry.file === clip.use);
  if (!anchor || !clip || !version || version.from === null) return false;
  if (version.from !== anchor.image) return true;
  const next = track.anchors[index + 1];
  if (clip.then !== 'extend' || !next) return false;
  if (next.from?.clip === clip.id) return false;
  // A version made without an end frame was never meant to land on an image, so it can't be out of date with one.
  return version.to !== null && version.to !== next.image;
}

export function clipState(track: StudioTrack, index: number): ClipState {
  const clip = track.anchors[index]?.clip;
  if (!clip || !clip.use) return clip?.requestedAt ? 'requested' : 'empty';
  return clipIsStale(track, index) ? 'stale' : 'ready';
}

/** Seconds the clip plays in the film. */
export function clipPlaySeconds(clip: TrackClip): number {
  if (!clip.use) return clip.plannedSeconds;
  if (clip.end !== null) return clip.end;
  return clip.versions.find((version) => version.file === clip.use)?.seconds ?? clip.plannedSeconds;
}

export function trackRuntime(track: StudioTrack): number {
  return Math.round(track.anchors.reduce((sum, anchor) => sum + (anchor.clip?.use ? clipPlaySeconds(anchor.clip) : 0), 0) * 10) / 10;
}

export type SceneRun = { first: string; number: number; anchors: string[]; name: string; world: string };

/** A scene is a run of anchors joined by Extends; every Cut starts a new one. */
export function sceneRuns(track: StudioTrack): SceneRun[] {
  const runs: SceneRun[] = [];
  track.anchors.forEach((anchor, index) => {
    const previous = track.anchors[index - 1];
    if (!previous || previous.clip?.then === 'cut') {
      const scene = track.scenes[anchor.id];
      runs.push({ first: anchor.id, number: runs.length + 1, anchors: [], name: scene?.name ?? '', world: scene?.world ?? '' });
    }
    runs[runs.length - 1]!.anchors.push(anchor.id);
  });
  return runs;
}

export type ExportCheck = { blockers: string[]; stale: string[] };

export function exportCheck(track: StudioTrack): ExportCheck {
  const blockers: string[] = [];
  const stale: string[] = [];
  if (!track.anchors.some((anchor) => anchor.clip?.use)) blockers.push('Make or add at least one clip first.');
  track.anchors.forEach((anchor, index) => {
    const clip = anchor.clip;
    if (!clip || index === track.anchors.length - 1) {
      if (clip && clipIsStale(track, index)) stale.push(clipName(track, anchor.id));
      return;
    }
    const name = clipName(track, anchor.id);
    if (!clip.use) blockers.push(`${name} is empty.`);
    if (clip.then === null) blockers.push(`Choose Cut or Extend after ${name}.`);
    if (clipIsStale(track, index)) stale.push(name);
  });
  return { blockers, stale };
}

/**
 * Clips whose version in use would not match this anchor if its image became
 * `file`: the clip landing on it through an Extend, and the clip leaving it.
 * Putting back the image a clip was made from touches nothing.
 */
export function clipsTouching(track: StudioTrack, anchorId: string, file: string): string[] {
  const index = track.anchors.findIndex((anchor) => anchor.id === anchorId);
  if (index < 0) return [];
  const touching: string[] = [];
  const inUse = (anchor: TrackAnchor | undefined) => anchor?.clip?.versions.find((version) => version.file === anchor.clip?.use);
  const previous = track.anchors[index - 1];
  const landing = inUse(previous);
  if (previous && landing && previous.clip!.then === 'extend' && landing.to !== null && landing.to !== file) touching.push(previous.id);
  const leaving = inUse(track.anchors[index]);
  if (leaving && leaving.from !== null && leaving.from !== file) touching.push(anchorId);
  return touching;
}

export function libraryUseOf(track: StudioTrack): { inUse: Set<string>; earlier: Set<string> } {
  const inUse = new Set<string>();
  const earlier = new Set<string>();
  for (const anchor of track.anchors) {
    if (anchor.image) inUse.add(anchor.image);
    anchor.earlier.forEach((file) => earlier.add(file));
    const clip = anchor.clip;
    if (!clip) continue;
    if (clip.use) inUse.add(clip.use);
    clip.versions.forEach((version) => earlier.add(version.file));
  }
  inUse.forEach((file) => earlier.delete(file));
  return { inUse, earlier };
}

// ---------- edits ----------

export class TrackEditError extends Error {}

function fail(message: string): never {
  throw new TrackEditError(message);
}

function nextId(track: StudioTrack, prefix: 'a' | 'c'): string {
  const value = `${prefix}${String(track.nextId)}`;
  track.nextId += 1;
  return value;
}

function newClip(track: StudioTrack): TrackClip {
  return blankClip(nextId(track, 'c'));
}

function findAnchor(track: StudioTrack, anchorId: string): { anchor: TrackAnchor; index: number } {
  const index = track.anchors.findIndex((anchor) => anchor.id === anchorId);
  if (index < 0) fail('That anchor is no longer on the track.');
  return { anchor: track.anchors[index]!, index };
}

function clipOf(track: StudioTrack, anchorId: string): { clip: TrackClip; anchor: TrackAnchor; index: number } {
  const found = findAnchor(track, anchorId);
  if (!found.anchor.clip) found.anchor.clip = newClip(track);
  return { ...found, clip: found.anchor.clip };
}

function setImage(anchor: TrackAnchor, file: string | null, from: TrackAnchor['from'] = null): void {
  if (anchor.image && anchor.image !== file && !anchor.earlier.includes(anchor.image)) anchor.earlier.push(anchor.image);
  anchor.earlier = anchor.earlier.filter((entry) => entry !== file);
  anchor.image = file;
  anchor.from = from;
  anchor.requestedAt = null;
}

/** Media a track edit may point at: files the project's library holds. */
export type TrackFiles = { has: (file: string) => boolean; seconds?: (file: string) => number | null };

/**
 * Applies an edit that changes only track.json. File work (import, trim frames,
 * export) happens in the main process before or after.
 */
export function applyTrackEdit(source: StudioTrack, edit: TrackEdit, files: TrackFiles, extras: { frame?: string; now?: number } = {}): StudioTrack {
  const track = structuredClone(source);
  const now = extras.now ?? Date.now();
  const requireFile = (file: string, kind: 'image' | 'video'): string => {
    const normalized = normalizeStudioPath(file);
    if (!normalized || studioMediaKind(normalized) !== kind || !files.has(normalized)) fail(kind === 'image' ? 'Choose a picture from the library.' : 'Choose a video from the library.');
    return normalized;
  };
  switch (edit.type) {
    case 'add-anchor': {
      if (track.anchors.length >= MAX_ANCHORS) fail('The track is full.');
      const index = Math.max(0, Math.min(track.anchors.length, Math.floor(edit.index)));
      const anchor: TrackAnchor = { id: nextId(track, 'a'), image: edit.file ? requireFile(edit.file, 'image') : null, earlier: [], from: null, title: text(edit.title, 120), prompt: text(edit.prompt, 2000), requestedAt: null, clip: null };
      const previous = track.anchors[index - 1];
      const following = track.anchors[index];
      if (previous) {
        const clip = previous.clip ?? (previous.clip = newClip(track));
        if (following) {
          // The old gap splits in two: the new anchor keeps the old boundary to
          // the next one, and the new boundary waits for the user's choice.
          anchor.clip = { ...newClip(track), then: clip.then };
          clip.then = null;
        } else {
          clip.then = edit.scene === 'new' ? 'cut' : edit.scene === 'continue' ? 'extend' : null;
        }
      } else if (following) {
        anchor.clip = newClip(track);
      }
      track.anchors.splice(index, 0, anchor);
      break;
    }
    case 'set-image': {
      setImage(findAnchor(track, edit.anchor).anchor, requireFile(edit.file, 'image'));
      break;
    }
    case 'remove-anchor': {
      const { index } = findAnchor(track, edit.anchor);
      track.anchors.splice(index, 1);
      const previous = track.anchors[index - 1];
      if (previous?.clip) previous.clip.then = null;
      if (previous && !track.anchors[index] && previous.clip && previous.clip.versions.length === 0) previous.clip = null;
      if (!previous && track.anchors[0] && edit.anchor in track.scenes) {
        track.scenes[track.anchors[0].id] ??= track.scenes[edit.anchor]!;
      }
      delete track.scenes[edit.anchor];
      if (track.anchors.length > 0) {
        const last = track.anchors[track.anchors.length - 1]!;
        if (last.clip) last.clip.then = null;
      }
      break;
    }
    case 'move-anchor': {
      const { anchor, index } = findAnchor(track, edit.anchor);
      const to = Math.max(0, Math.min(track.anchors.length - 1, Math.floor(edit.to)));
      if (to === index) break;
      const touched = new Set([track.anchors[index - 1]?.id, anchor.id]);
      track.anchors.splice(index, 1);
      track.anchors.splice(to, 0, anchor);
      touched.add(track.anchors[to - 1]?.id);
      for (const key of touched) {
        const moved = track.anchors.find((entry) => entry.id === key);
        if (moved?.clip) moved.clip.then = null;
      }
      track.anchors.forEach((entry, position) => {
        if (position < track.anchors.length - 1 && !entry.clip) entry.clip = newClip(track);
      });
      const last = track.anchors[track.anchors.length - 1]!;
      if (last.clip) last.clip.then = null;
      break;
    }
    case 'clip': {
      const { clip } = clipOf(track, edit.anchor);
      if (edit.plannedSeconds !== undefined) {
        if (!Number.isFinite(edit.plannedSeconds) || edit.plannedSeconds < MIN_CLIP_SECONDS || edit.plannedSeconds > MAX_CLIP_SECONDS) {
          fail(`Choose a length from ${String(MIN_CLIP_SECONDS)} to ${String(MAX_CLIP_SECONDS)} seconds.`);
        }
        clip.plannedSeconds = Math.round(edit.plannedSeconds);
      }
      if (edit.prompt !== undefined) clip.prompt = edit.prompt.trim().slice(0, 2000);
      break;
    }
    case 'anchor-prompt': {
      findAnchor(track, edit.anchor).anchor.prompt = edit.prompt.trim().slice(0, 2000);
      break;
    }
    case 'title': {
      findAnchor(track, edit.anchor).anchor.title = edit.title.trim().slice(0, 120);
      break;
    }
    case 'then': {
      const { clip, index } = clipOf(track, edit.anchor);
      const next = track.anchors[index + 1];
      if (edit.then === 'extend' && clip.end !== null && clip.endFrame) {
        // The trimmed end frame becomes the next anchor, so the next clip starts where this one stops.
        if (next) setImage(next, clip.endFrame, { clip: clip.id, at: clip.end });
        else track.anchors.push({ id: nextId(track, 'a'), image: clip.endFrame, earlier: [], from: { clip: clip.id, at: clip.end }, title: '', prompt: '', requestedAt: null, clip: null });
      } else if (!next) {
        fail('This is the last clip. Add an anchor after it first.');
      }
      clip.then = edit.then;
      break;
    }
    case 'trim': {
      const { clip, index } = clipOf(track, edit.anchor);
      if (!clip.use) fail('There is no clip to trim yet.');
      const length = clip.versions.find((version) => version.file === clip.use)?.seconds ?? null;
      if (!Number.isFinite(edit.end) || edit.end < 0.1 || (length !== null && edit.end > length)) fail('Pick an end inside the clip.');
      if (!extras.frame) fail('The end frame could not be saved.');
      clip.end = Math.round(edit.end * 100) / 100;
      clip.endFrame = extras.frame;
      track.labels[extras.frame] = `${clipName(track, edit.anchor)} · frame at ${String(clip.end)} s`;
      // A new end frame needs a new decision.
      if (track.anchors[index + 1]) clip.then = null;
      break;
    }
    case 'reset-trim': {
      const { clip, index } = clipOf(track, edit.anchor);
      const next = track.anchors[index + 1];
      // The frame this trim gave the next shot goes back to the library, and the image it replaced returns.
      const replaced = next?.from?.clip === clip.id ? next.earlier.at(-1) : undefined;
      if (next && replaced) setImage(next, replaced);
      clip.end = null;
      clip.endFrame = null;
      if (next) clip.then = null;
      break;
    }
    case 'use-version': {
      const { clip } = clipOf(track, edit.anchor);
      const file = requireFile(edit.file, 'video');
      if (!clip.versions.some((version) => version.file === file)) fail('That version belongs to another clip.');
      clip.use = file;
      clip.end = null;
      clip.endFrame = null;
      break;
    }
    case 'add-version': {
      const { clip } = clipOf(track, edit.anchor);
      const file = requireFile(edit.file, 'video');
      if (!clip.versions.some((version) => version.file === file)) {
        clip.versions.push({ file, from: null, to: null, seconds: files.seconds?.(file) ?? null, label: track.labels[file] ?? 'From the library', addedAt: now });
      }
      clip.use = file;
      clip.end = null;
      clip.endFrame = null;
      break;
    }
    case 'scene': {
      findAnchor(track, edit.anchor);
      track.scenes[edit.anchor] = { name: edit.name.trim().slice(0, 120), world: edit.world.trim().slice(0, 400) };
      break;
    }
    case 'request': {
      for (const key of edit.clips) {
        const { clip, index } = clipOf(track, key);
        // The request says whether the clip has an end frame, so the user decides that first.
        if (clip.then === null && track.anchors[index + 1]) fail(`Choose Cut or Extend after ${clipName(track, key)} first.`);
        clip.requestedAt = now;
      }
      for (const key of edit.images) findAnchor(track, key).anchor.requestedAt = now;
      break;
    }
    case 'aspect': {
      const ratio = STUDIO_ASPECT_RATIOS.find((candidate) => candidate === edit.aspectRatio);
      if (!ratio) fail('Choose 16:9, 9:16 or 1:1.');
      track.aspectRatio = ratio;
      break;
    }
    default:
      fail('Unknown edit.');
  }
  return track;
}

/**
 * The state Undo goes back to: the earlier edit, with every file the agent
 * delivered since put back where it went, so Undo never takes away paid work.
 * Refuses when a delivery went into a place the undone edit made.
 */
export function undoTo(earlier: StudioTrack, now: StudioTrack): StudioTrack {
  let track = structuredClone(earlier);
  const known = new Set(earlier.delivered.map((entry) => entry.key));
  for (const entry of now.delivered) {
    if (known.has(entry.key)) continue;
    const next = applyStudioDelivery(track, entry.delivery, entry.seconds, entry.at, { record: false });
    if (!next) {
      const delivery = entry.delivery;
      const target = delivery.kind === 'clip'
        ? now.anchors.find((candidate) => candidate.clip?.id === delivery.clip)
        : now.anchors.find((candidate) => candidate.id === delivery.anchor);
      const place = !target ? 'a place' : delivery.kind === 'clip' ? clipName(now, target.id) : anchorName(now, target.id);
      fail(`Undo would take ${place} off the track, and the agent has delivered a file into it since. Remove it yourself if you want it gone.`);
    }
    track = next;
  }
  const anchorsNow = new Map(now.anchors.map((anchor) => [anchor.id, anchor]));
  for (const anchor of track.anchors) {
    const current = anchorsNow.get(anchor.id);
    if (!current) continue;
    for (const file of [...current.earlier, ...(current.image ? [current.image] : [])]) {
      if (file !== anchor.image && !anchor.earlier.includes(file)) anchor.earlier.push(file);
    }
  }
  track.labels = { ...earlier.labels, ...now.labels };
  track.exports = now.exports;
  track.spent = now.spent;
  track.delivered = now.delivered;
  track.nextId = Math.max(earlier.nextId, now.nextId);
  return track;
}

/** Applies a file the agent delivered. Returns null when it no longer has a place on the track. */
export function applyStudioDelivery(source: StudioTrack, delivery: StudioDelivery, seconds: number | null, now: number, options: { record?: boolean } = {}): StudioTrack | null {
  const log = options.record ?? true;
  const track = structuredClone(source);
  if (delivery.kind === 'image') {
    const anchor = track.anchors.find((entry) => entry.id === delivery.anchor);
    if (!anchor) return null;
    setImage(anchor, delivery.file);
  } else {
    const index = track.anchors.findIndex((entry) => entry.clip?.id === delivery.clip);
    if (index < 0) return null;
    const anchor = track.anchors[index]!;
    const clip = anchor.clip!;
    const next = track.anchors[index + 1];
    clip.versions = clip.versions.filter((version) => version.file !== delivery.file);
    clip.versions.push({
      file: delivery.file,
      from: anchor.image,
      to: clip.then === 'extend' && next ? next.image : null,
      seconds,
      label: delivery.model || 'Generated',
      addedAt: now,
    });
    clip.use = delivery.file;
    clip.end = null;
    clip.endFrame = null;
    clip.requestedAt = null;
    if (next?.from?.clip === clip.id) next.from = null;
  }
  if (log) track.delivered = [...track.delivered, { key: `${String(now)}:${delivery.file}`, at: now, seconds, delivery }].slice(-200);
  if (log && delivery.usd !== null) {
    const label = delivery.kind === 'image' ? `${anchorName(track, delivery.anchor)} image` : clipName(track, track.anchors.find((entry) => entry.clip?.id === delivery.clip)!.id);
    track.spent.push({ label, detail: delivery.model, usd: delivery.usd });
  }
  return track;
}

/** Opens a storyboard made before the track editor: each shot's still is an anchor, its clip a version, every boundary a Cut. */
export function trackFromBoard(board: StudioBoard, files: TrackFiles, now: number): StudioTrack {
  const track = emptyStudioTrack();
  if (STUDIO_ASPECT_RATIOS.some((ratio) => ratio === board.aspectRatio)) track.aspectRatio = board.aspectRatio;
  board.shots.forEach((shot, index) => {
    const image = shot.still && files.has(shot.still) ? shot.still : null;
    const anchor: TrackAnchor = { id: nextId(track, 'a'), image, earlier: [], from: null, title: shot.title, prompt: shot.description, requestedAt: null, clip: null };
    const clipFile = shot.clip && files.has(shot.clip) ? shot.clip : null;
    if (clipFile || index < board.shots.length - 1) {
      const clip = newClip(track);
      if (shot.durationSeconds !== null) clip.plannedSeconds = Math.max(MIN_CLIP_SECONDS, Math.min(MAX_CLIP_SECONDS, Math.round(shot.durationSeconds)));
      clip.prompt = shot.description;
      clip.then = index < board.shots.length - 1 ? 'cut' : null;
      if (clipFile) {
        clip.versions.push({ file: clipFile, from: image, to: null, seconds: files.seconds?.(clipFile) ?? null, label: `Shot ${shot.id}`, addedAt: now });
        clip.use = clipFile;
      }
      anchor.clip = clip;
    }
    track.anchors.push(anchor);
    if (shot.title && (index === 0)) track.scenes[anchor.id] = { name: shot.title, world: board.style };
  });
  track.spent = [...board.spent];
  return track;
}
