import {
  normalizeStudioPath,
  parseCostLines,
  parseMediaPath as media,
  parseRecord as record,
  parseText as text,
  studioMediaKind,
  type StudioBoard,
  type StudioCostLine,
} from './studio.js';

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

/** The images a clip was asked to start from and land on. */
export type ClipInputs = { from: string | null; to: string | null };

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
  /** The images the clip was asked for with, so a clip delivered after they changed shows as out of date. */
  requested: ClipInputs | null;
};

export type TrackAnchor = {
  id: string;
  image: string | null;
  earlier: string[];
  /**
   * Set when the image is a frame taken from a clip (a trim that extends).
   * `replaced` is the image the shot had before that frame, null when it had
   * none: Reset end puts it back, however often the clip was trimmed since.
   */
  from: { clip: string; at: number; replaced: string | null } | null;
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
  /**
   * The inbox files already taken in, saved with the track they changed, so
   * a delivery whose file could not be moved out of the inbox is never
   * applied twice.
   */
  ingested: IngestRecord[];
  nextId: number;
};

/** `key`: the inbox file's name, time and content; `applied`: whether it went on the track. */
export type IngestRecord = { key: string; applied: boolean };

/** `inputs`: the images a delivered clip was made from, so Undo puts it back with them. */
export type DeliveryRecord = { key: string; at: number; seconds: number | null; delivery: StudioDelivery; inputs?: ClipInputs };

/** What an edit in the app returns. `imported`: the pictures an import added to the library, in order. */
export type StudioEditResult = { track: StudioTrack; message?: string; imported?: string[] };

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
/** The longest video, trim or frame time the track keeps; an edit takes no more than a read keeps. */
export const MAX_MEDIA_SECONDS = 24 * 60 * 60;
const MAX_ANCHORS = 120;
/** The deliveries a track remembers taking in, so one is never taken twice; the oldest go first. */
export const MAX_INGESTED = 200;
/** The deliveries a track logs; the oldest go first. */
const MAX_DELIVERED = 200;
const MAX_VERSIONS = 64;
/** The exports a track lists; the oldest go first. */
const MAX_EXPORTS = 50;
/** Ids are a letter and up to six digits. */
const MAX_ID = 999_999;

export function emptyStudioTrack(): StudioTrack {
  return { version: 1, aspectRatio: '16:9', anchors: [], scenes: {}, labels: {}, spent: [], exports: [], delivered: [], ingested: [], nextId: 1 };
}

// ---------- parsing ----------

function seconds(value: unknown, max = MAX_MEDIA_SECONDS): number | null {
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

/** The version in use and the newest others, oldest first, so a clip never loses the one it plays. */
function limitVersions(versions: ClipVersion[], use: string | null): ClipVersion[] {
  if (versions.length <= MAX_VERSIONS) return versions;
  const kept = new Set(versions.filter((version) => version.file !== use).slice(-(MAX_VERSIONS - 1)));
  return versions.filter((version) => version.file === use || kept.has(version));
}

/** The newest earlier images, oldest first and each once, so a shot keeps the alternatives it had last. */
function limitEarlier(entries: string[]): string[] {
  const kept: string[] = [];
  for (let index = entries.length - 1; index >= 0 && kept.length < MAX_VERSIONS; index -= 1) {
    if (!kept.includes(entries[index]!)) kept.push(entries[index]!);
  }
  return kept.reverse();
}

function parseInputs(value: unknown): ClipInputs | null {
  const item = record(value);
  return item ? { from: media(item['from'], 'image'), to: media(item['to'], 'image') } : null;
}

function parseClip(value: unknown): TrackClip | null {
  const item = record(value);
  const clipId = id(item?.['id']);
  if (!item || !clipId) return null;
  const use = media(item['use'], 'video');
  const versions = limitVersions(Array.isArray(item['versions'])
    ? item['versions'].map(parseVersion).filter((version): version is ClipVersion => version !== null)
    : [], use);
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
    requested: parseInputs(item['requested']),
  };
}

function parseAnchor(value: unknown): TrackAnchor | null {
  const item = record(value);
  const anchorId = id(item?.['id']);
  if (!item || !anchorId) return null;
  const from = record(item['from']);
  const fromClip = id(from?.['clip']);
  const fromAt = seconds(from?.['at']);
  const earlier = Array.isArray(item['earlier'])
    ? limitEarlier(item['earlier'].map((entry) => media(entry, 'image')).filter((entry): entry is string => entry !== null))
    : [];
  // A frame saved before `replaced` was kept took the place of the image saved last.
  const replaced = from && 'replaced' in from ? media(from['replaced'], 'image') : earlier.at(-1) ?? null;
  return {
    id: anchorId,
    image: media(item['image'], 'image'),
    earlier,
    from: fromClip && fromAt !== null ? { clip: fromClip, at: fromAt, replaced } : null,
    title: text(item['title'], 120),
    prompt: text(item['prompt'], 2000),
    requestedAt: stamp(item['requestedAt']),
    clip: parseClip(item['clip']),
  };
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
      ? item['exports'].slice(-MAX_EXPORTS).map((entry) => media(entry, 'video')).filter((entry): entry is string => entry !== null)
      : [],
    delivered: Array.isArray(item['delivered']) ? item['delivered'].slice(-MAX_DELIVERED).flatMap((entry): DeliveryRecord[] => {
      const recordEntry = record(entry);
      const delivery = parseStudioDelivery(recordEntry?.['delivery']);
      // A key is the delivery's time and file, and a file's path may take 300 characters.
      const key = text(recordEntry?.['key'], 400);
      if (!delivery || !key) return [];
      const inputs = parseInputs(recordEntry?.['inputs']);
      return [{ key, at: stamp(recordEntry?.['at']) ?? 0, seconds: seconds(recordEntry?.['seconds']), delivery, ...(inputs ? { inputs } : {}) }];
    }) : [],
    ingested: Array.isArray(item['ingested']) ? item['ingested'].slice(-MAX_INGESTED).flatMap((entry): IngestRecord[] => {
      const recordEntry = record(entry);
      const key = text(recordEntry?.['key'], 400);
      return key && typeof recordEntry?.['applied'] === 'boolean' ? [{ key, applied: recordEntry['applied'] }] : [];
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
  return { id: clipId, plannedSeconds: DEFAULT_CLIP_SECONDS, prompt: '', then: null, use: null, end: null, endFrame: null, versions: [], requestedAt: null, requested: null };
}

function blankAnchor(anchorId: string, image: string | null): TrackAnchor {
  return { id: anchorId, image, earlier: [], from: null, title: '', prompt: '', requestedAt: null, clip: null };
}

// ---------- deliveries from the agent ----------

/**
 * A clip delivery may say which images it was made from (`startFrame`, and
 * `endFrame` or null for no end frame): those, not the track's images when it
 * arrives, are what it is checked against.
 */
export type StudioDelivery =
  | { kind: 'clip'; clip: string; file: string; usd: number | null; model: string; startFrame?: string; endFrame?: string | null }
  | { kind: 'image'; anchor: string; file: string; usd: number | null; model: string };

/** The edits the agent may ask for when the user tells it in chat. Each one is undoable, like the user's own. */
export type StudioAgentEdit = Extract<TrackEdit, { type: 'title' | 'anchor-prompt' | 'clip' | 'then' | 'scene' | 'add-anchor' | 'move-anchor' | 'remove-anchor' | 'use-version' | 'aspect' }>;

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const USER_ONLY_EDIT_TYPES = new Set(['undo', 'export', 'trim', 'reset-trim', 'import', 'convert', 'request', 'set-image', 'add-version', 'dismiss-notices']);

/** Whether a delivery is an {"edit": ...}, whether or not the edit is one the app takes. */
export function isStudioAgentEditRequest(raw: unknown): boolean {
  return record(record(raw)?.['edit']) !== null;
}

/** Whether the agent asked for an edit only the user may make (Undo, a trim, an export...). */
export function isUserOnlyStudioEdit(raw: unknown): boolean {
  const type = record(record(raw)?.['edit'])?.['type'];
  return typeof type === 'string' && USER_ONLY_EDIT_TYPES.has(type);
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
    if (!file) return null;
    const startFrame = media(item['startFrame'], 'image');
    return startFrame
      ? { kind: 'clip', clip, file, usd, model, startFrame, endFrame: media(item['endFrame'], 'image') }
      : { kind: 'clip', clip, file, usd, model };
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
/**
 * Why the clip in use no longer fits the track, or null when it does:
 * - `image`: it starts from an image the shot has since replaced;
 * - `end`: it is an Extend but lands on another image than the next shot's;
 * - `cut`: it was made for a Cut, with no end frame, and is now an Extend.
 * A Cut takes any clip: one made for an Extend still plays to its end, and the film cuts after it.
 */
export function clipStaleReason(track: StudioTrack, index: number): 'image' | 'end' | 'cut' | null {
  const anchor = track.anchors[index];
  const clip = anchor?.clip;
  const version = clip?.versions.find((entry) => entry.file === clip.use);
  if (!anchor || !clip || !version || version.from === null) return null;
  if (version.from !== anchor.image) return 'image';
  const next = track.anchors[index + 1];
  if (clip.then !== 'extend' || !next) return null;
  // The next shot's image is this clip's own end frame (a trim that extends): it lands there by definition.
  if (next.from?.clip === clip.id && clip.endFrame !== null && clip.endFrame === next.image && clip.end === next.from.at) return null;
  if (version.to === null) return 'cut';
  return version.to !== next.image ? 'end' : null;
}

export function clipIsStale(track: StudioTrack, index: number): boolean {
  return clipStaleReason(track, index) !== null;
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
  if (track.nextId > MAX_ID) fail('The track is full.');
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
  anchor.earlier = limitEarlier(anchor.earlier.filter((entry) => entry !== file));
  anchor.image = file;
  anchor.from = from;
  anchor.requestedAt = null;
}

/**
 * Puts a version in use. Its trim belongs to the version it replaces, and so
 * does the frame that trim gave the next shot: that shot keeps the image but
 * no longer counts as this clip's own end.
 */
function activateClipVersion(track: StudioTrack, index: number, file: string): void {
  const clip = track.anchors[index]!.clip!;
  clip.use = file;
  clip.end = null;
  clip.endFrame = null;
  clip.versions = limitVersions(clip.versions, file);
  const next = track.anchors[index + 1];
  if (next?.from?.clip === clip.id) next.from = null;
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
      const anchor: TrackAnchor = {
        ...blankAnchor(nextId(track, 'a'), edit.file ? requireFile(edit.file, 'image') : null),
        title: text(edit.title, 120),
        prompt: text(edit.prompt, 2000),
      };
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
        // The image to put back on Reset end is the one before this clip's first frame, not an earlier frame of it.
        if (next) setImage(next, clip.endFrame, { clip: clip.id, at: clip.end, replaced: next.from?.clip === clip.id ? next.from.replaced : next.image });
        else if (track.anchors.length >= MAX_ANCHORS) fail('The track is full.');
        else track.anchors.push({ ...blankAnchor(nextId(track, 'a'), clip.endFrame), from: { clip: clip.id, at: clip.end, replaced: null } });
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
      if (!Number.isFinite(edit.end) || edit.end < 0.1 || edit.end > MAX_MEDIA_SECONDS || (length !== null && edit.end > length)) fail('Pick an end inside the clip.');
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
      // The frame this trim gave the next shot goes back to the library, and the image it replaced returns (or none, if it had none).
      if (next?.from?.clip === clip.id) setImage(next, next.from.replaced);
      clip.end = null;
      clip.endFrame = null;
      if (next) clip.then = null;
      break;
    }
    case 'use-version': {
      const { clip, index } = clipOf(track, edit.anchor);
      const file = requireFile(edit.file, 'video');
      if (!clip.versions.some((version) => version.file === file)) fail('That version belongs to another clip.');
      activateClipVersion(track, index, file);
      break;
    }
    case 'add-version': {
      const { clip, index } = clipOf(track, edit.anchor);
      const file = requireFile(edit.file, 'video');
      if (!clip.versions.some((version) => version.file === file)) {
        // An upload's name may be longer than a version's label takes.
        clip.versions.push({ file, from: null, to: null, seconds: seconds(files.seconds?.(file)), label: text(track.labels[file], 120) || 'From the library', addedAt: now });
      }
      activateClipVersion(track, index, file);
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
        const next = track.anchors[index + 1];
        if (clip.then === null && next) fail(`Choose Cut or Extend after ${clipName(track, key)} first.`);
        clip.requestedAt = now;
        clip.requested = clipInputs(track, index);
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
    const next = applyStudioDelivery(track, entry.delivery, entry.seconds, entry.at, { record: false, inputs: entry.inputs });
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
    anchor.earlier = limitEarlier(anchor.earlier);
  }
  track.labels = { ...earlier.labels, ...now.labels };
  track.exports = now.exports;
  track.spent = now.spent;
  track.delivered = now.delivered;
  track.ingested = now.ingested;
  track.nextId = Math.max(earlier.nextId, now.nextId);
  return track;
}

/** The images a clip made now would start from and land on, as the request to the agent names them. */
function clipInputs(track: StudioTrack, index: number): ClipInputs {
  const anchor = track.anchors[index]!;
  const next = track.anchors[index + 1];
  return { from: anchor.image, to: anchor.clip?.then === 'extend' && next ? next.image : null };
}

/**
 * Applies a file the agent delivered. Returns null when it no longer has a place on the track.
 * A clip is recorded as made from the images it says it was made from, else the ones it was
 * asked for with in the editor (or `options.inputs`, on Undo), and only failing both from the
 * track's images now: an image replaced while it was being made leaves it out of date.
 * `options.key` names the delivery for Undo; deliveries read together share `now`, so the inbox
 * gives each its own.
 */
export function applyStudioDelivery(source: StudioTrack, delivery: StudioDelivery, length: number | null, now: number, options: { record?: boolean; inputs?: ClipInputs; key?: string } = {}): StudioTrack | null {
  const log = options.record ?? true;
  // A length a read would drop is not kept now either.
  const duration = seconds(length);
  const track = structuredClone(source);
  let inputs: ClipInputs | undefined;
  if (delivery.kind === 'image') {
    const anchor = track.anchors.find((entry) => entry.id === delivery.anchor);
    if (!anchor) return null;
    setImage(anchor, delivery.file);
  } else {
    const index = track.anchors.findIndex((entry) => entry.clip?.id === delivery.clip);
    if (index < 0) return null;
    const clip = track.anchors[index]!.clip!;
    const stated = delivery.startFrame ? { from: delivery.startFrame, to: delivery.endFrame ?? null } : null;
    inputs = options.inputs ?? stated ?? clip.requested ?? clipInputs(track, index);
    clip.versions = clip.versions.filter((version) => version.file !== delivery.file);
    clip.versions.push({ file: delivery.file, from: inputs.from, to: inputs.to, seconds: duration, label: delivery.model || 'Generated', addedAt: now });
    activateClipVersion(track, index, delivery.file);
    clip.requestedAt = null;
    clip.requested = null;
  }
  if (log) track.delivered = [...track.delivered, { key: options.key ?? `${String(now)}:${delivery.file}`, at: now, seconds: duration, delivery, ...(inputs ? { inputs } : {}) }].slice(-MAX_DELIVERED);
  if (log && delivery.usd !== null) {
    const label = delivery.kind === 'image' ? `${anchorName(track, delivery.anchor)} image` : clipName(track, track.anchors.find((entry) => entry.clip?.id === delivery.clip)!.id);
    track.spent.push({ label, detail: delivery.model, usd: delivery.usd });
  }
  return track;
}

/** The track with a film exported to `file`, listing only as many exports as a read keeps. */
export function addStudioExport(track: StudioTrack, file: string): StudioTrack {
  return { ...track, exports: [...track.exports, file].slice(-MAX_EXPORTS) };
}

/** Opens a storyboard made before the track editor: each shot's still is an anchor, its clip a version, every boundary a Cut. */
export function trackFromBoard(board: StudioBoard, files: TrackFiles, now: number): StudioTrack {
  const track = emptyStudioTrack();
  if (STUDIO_ASPECT_RATIOS.some((ratio) => ratio === board.aspectRatio)) track.aspectRatio = board.aspectRatio;
  board.shots.forEach((shot, index) => {
    const image = shot.still && files.has(shot.still) ? shot.still : null;
    // A board takes longer titles and style lines than a track: they are cut to what a read keeps.
    const anchor: TrackAnchor = { ...blankAnchor(nextId(track, 'a'), image), title: text(shot.title, 120), prompt: shot.description };
    const clipFile = shot.clip && files.has(shot.clip) ? shot.clip : null;
    if (clipFile || index < board.shots.length - 1) {
      const clip = newClip(track);
      if (shot.durationSeconds !== null) clip.plannedSeconds = Math.max(MIN_CLIP_SECONDS, Math.min(MAX_CLIP_SECONDS, Math.round(shot.durationSeconds)));
      clip.prompt = shot.description;
      clip.then = index < board.shots.length - 1 ? 'cut' : null;
      if (clipFile) {
        clip.versions.push({ file: clipFile, from: image, to: null, seconds: seconds(files.seconds?.(clipFile)), label: `Shot ${shot.id}`, addedAt: now });
        clip.use = clipFile;
      }
      anchor.clip = clip;
    }
    track.anchors.push(anchor);
    if (shot.title && (index === 0)) track.scenes[anchor.id] = { name: text(shot.title, 120), world: text(board.style, 400) };
  });
  track.spent = [...board.spent];
  return track;
}
