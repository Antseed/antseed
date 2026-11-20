import { randomUUID } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { STUDIO_BOARD_FILE, STUDIO_MEDIA_TOOLS_MISSING, studioMediaKind, type StudioBoard } from '../../shared/studio.js';
import {
  applyStudioDelivery,
  applyTrackEdit,
  emptyStudioTrack,
  exportCheck,
  libraryUseOf,
  parseStudioAgentEdit,
  studioAgentEditProblem,
  parseStudioDelivery,
  parseStudioTrack,
  STUDIO_DELIVERIES_DIR,
  STUDIO_TRACK_FILE,
  trackFromBoard,
  TrackEditError,
  undoTo,
  type StudioLibraryItem,
  type StudioTrack,
  type TrackEdit,
  type TrackFiles,
} from '../../shared/studio-track.js';
import { createSerialQueue } from '../serial-queue.js';

const run = promisify(execFile);
const queue = createSerialQueue();

const HISTORY_FILE = 'track.history.json';
const HISTORY_LIMIT = 30;
const MAX_TRACK_BYTES = 2 * 1024 * 1024;
const MAX_LIBRARY_FILES = 2000;
const SKIPPED_DIRS = new Set([STUDIO_DELIVERIES_DIR, 'node_modules']);

/** The project folder, refused when it is a link or resolves outside the Studio folder. */
export async function studioFolder(id: string, root: string): Promise<string> {
  const dir = path.join(root, id);
  if ((await lstat(dir)).isSymbolicLink() || await realpath(dir) !== path.join(await realpath(root), id)) throw new Error('Invalid project folder');
  return dir;
}

async function exists(file: string): Promise<boolean> {
  return lstat(file).then(() => true, () => false);
}

async function readJson(file: string, max: number): Promise<unknown> {
  const info = await lstat(file);
  if (!info.isFile() || info.size > max) throw new Error(`${path.basename(file)} is not readable`);
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

async function writeJsonAtomic(dir: string, name: string, value: unknown): Promise<void> {
  const tmp = path.join(dir, `.${randomUUID()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(tmp, path.join(dir, name));
}

export async function readStudioTrack(dir: string): Promise<StudioTrack | null> {
  try {
    return parseStudioTrack(await readJson(path.join(dir, STUDIO_TRACK_FILE), MAX_TRACK_BYTES));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Whether Undo has a step to go back to. */
export async function studioCanUndo(dir: string): Promise<boolean> {
  return (await readHistory(dir)).length > 0;
}

async function readHistory(dir: string): Promise<unknown[]> {
  try {
    const raw = await readJson(path.join(dir, HISTORY_FILE), MAX_TRACK_BYTES * 4);
    return Array.isArray(raw) ? raw.slice(-HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

async function saveTrack(dir: string, track: StudioTrack, previous: StudioTrack | null): Promise<void> {
  if (previous) await writeJsonAtomic(dir, HISTORY_FILE, [...await readHistory(dir), previous].slice(-HISTORY_LIMIT));
  await writeJsonAtomic(dir, STUDIO_TRACK_FILE, track);
}

/** Every picture and video in the project folder, so nothing made for the project is ever out of reach. */
export async function scanStudioMedia(dir: string): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 3 || found.size >= MAX_LIBRARY_FILES) return;
    let entries: Dirent[];
    try {
      entries = await readdir(path.join(dir, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || found.size >= MAX_LIBRARY_FILES) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(child, depth + 1);
      } else if (entry.isFile() && studioMediaKind(entry.name)) {
        try {
          found.set(child, Math.floor((await stat(path.join(dir, child))).mtimeMs));
        } catch {
          // Gone between the listing and the stat.
        }
      }
    }
  };
  await walk('', 0);
  return found;
}

export function studioLibrary(track: StudioTrack | null, media: Map<string, number>): StudioLibraryItem[] {
  const use = track ? libraryUseOf(track) : { inUse: new Set<string>(), earlier: new Set<string>() };
  const exports = new Set(track?.exports ?? []);
  return [...media.entries()]
    .map(([file, version]): StudioLibraryItem => ({
      file,
      kind: studioMediaKind(file)!,
      label: track?.labels[file] ?? path.posix.basename(file),
      version,
      status: use.inUse.has(file) ? 'in-use' : exports.has(file) ? 'export' : use.earlier.has(file) ? 'earlier' : 'unused',
    }))
    .sort((left, right) => right.version - left.version);
}

/** Whether `ffmpeg` and `ffprobe` both run from PATH. The desktop does not ship them; trim and export need them. */
export async function detectStudioMediaTools(): Promise<boolean> {
  const runs = (command: string) => run(command, ['-version'], { timeout: 10_000 }).then(() => true, () => false);
  const [ffmpeg, ffprobe] = await Promise.all([runs('ffmpeg'), runs('ffprobe')]);
  return ffmpeg && ffprobe;
}

let mediaTools: Promise<boolean> | null = null;

/** detectStudioMediaTools, checked once per launch. */
export function studioMediaTools(): Promise<boolean> {
  mediaTools ??= detectStudioMediaTools();
  return mediaTools;
}

/** ffmpeg, with a missing executable reported as the reason instead of ENOENT. */
async function ffmpeg(args: string[], options: { timeout: number; maxBuffer?: number }): Promise<void> {
  try {
    await run('ffmpeg', args, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new TrackEditError(STUDIO_MEDIA_TOOLS_MISSING);
    throw error;
  }
}

/** The video's length, or null when it cannot be read (ffprobe missing, or not a video it knows). */
async function probeSeconds(file: string): Promise<number | null> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 20_000 });
    const value = Number(stdout.trim());
    return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null;
  } catch {
    return null;
  }
}

async function mediaDir(dir: string, sub: string): Promise<string> {
  const target = path.join(dir, sub);
  await mkdir(target, { recursive: true });
  if (await realpath(target) !== path.join(await realpath(dir), sub)) throw new Error('Invalid media folder');
  return target;
}

function inputFormat(file: string): string[] {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.webm') return ['-f', 'matroska'];
  if (['.mp4', '.m4v', '.mov'].includes(extension)) return ['-f', 'mov'];
  return [];
}

async function saveFrame(dir: string, video: string, at: number): Promise<string> {
  await mediaDir(dir, 'frames');
  const relative = `frames/${randomUUID()}.png`;
  // The frame on screen at `at`; at the very end of a clip there is none, so step back to the last one.
  for (const seek of [at, at - 0.05, at - 0.2]) {
    await ffmpeg(['-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-ss', Math.max(0, seek).toFixed(3), ...inputFormat(video), '-i', path.join(dir, video), '-frames:v', '1', '-y', path.join(dir, relative)], { timeout: 60_000 });
    try {
      if ((await stat(path.join(dir, relative))).size > 0) return relative;
    } catch {
      // No frame at this time; try a little earlier.
    }
  }
  throw new TrackEditError('The end frame could not be saved.');
}

const CANVAS: Record<string, [number, number]> = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] };

async function exportFilm(dir: string, track: StudioTrack, media: Map<string, number>): Promise<string> {
  const { blockers } = exportCheck(track);
  if (blockers.length > 0) throw new TrackEditError(blockers[0]!);
  const missing = track.anchors.find((anchor) => anchor.clip?.use && !media.has(anchor.clip.use));
  if (missing) throw new TrackEditError(`${missing.clip!.use!} is missing from the project folder.`);
  const [width, height] = CANVAS[track.aspectRatio] ?? CANVAS['16:9']!;
  const clips = track.anchors.flatMap((anchor) => anchor.clip?.use ? [anchor.clip] : []);
  const inputs = clips.flatMap((clip) => [...inputFormat(clip.use!), '-i', path.join(dir, clip.use!)]);
  const parts = clips.map((clip, index) => {
    const trim = clip.end !== null ? `trim=end=${clip.end.toFixed(3)},setpts=PTS-STARTPTS,` : '';
    return `[${String(index)}:v:0]${trim}scale=${String(width)}:${String(height)}:force_original_aspect_ratio=decrease,pad=${String(width)}:${String(height)}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${String(index)}]`;
  });
  const join = `${clips.map((_, index) => `[v${String(index)}]`).join('')}concat=n=${String(clips.length)}:v=1:a=0[out]`;
  await mediaDir(dir, 'exports');
  const relative = `exports/film-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`;
  await ffmpeg([
    '-nostdin', '-v', 'error', '-protocol_whitelist', 'file', ...inputs,
    '-filter_complex', [...parts, join].join(';'), '-map', '[out]', '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', '-n', path.join(dir, relative),
  ], { timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 });
  return relative;
}

function trackFiles(media: Map<string, number>, seconds: Map<string, number | null>): TrackFiles {
  return { has: (file) => media.has(file), seconds: (file) => seconds.get(file) ?? null };
}

/** `imported`: the files an import added to the library, in order. */
export type StudioEditResult = { track: StudioTrack; message?: string; imported?: string[] };

/** Applies one edit to a project's track, one edit at a time across all projects. */
export function editStudioTrack(dir: string, edit: TrackEdit, options: { picked?: string[]; board?: StudioBoard } = {}): Promise<StudioEditResult> {
  return queue.run(async () => {
    const previous = await readStudioTrack(dir);
    const current = previous ?? emptyStudioTrack();
    const media = await scanStudioMedia(dir);
    const seconds = new Map<string, number | null>();
    switch (edit.type) {
      case 'undo': {
        const history = await readHistory(dir);
        const last = history.pop();
        if (last === undefined) throw new TrackEditError('Nothing to undo.');
        const restored = undoTo(parseStudioTrack(last), current);
        await writeJsonAtomic(dir, HISTORY_FILE, history);
        await writeJsonAtomic(dir, STUDIO_TRACK_FILE, restored);
        return { track: restored };
      }
      case 'import': {
        const picked = (options.picked ?? []).slice(0, 20);
        if (picked.length === 0) return { track: current };
        await mediaDir(dir, 'uploads');
        let track = current;
        const images: string[] = [];
        for (const source of picked) {
          const kind = studioMediaKind(source);
          if (!kind || !(await stat(source)).isFile()) throw new TrackEditError('Choose a picture or a video.');
          const relative = `uploads/${randomUUID()}${path.extname(source).toLowerCase()}`;
          await copyFile(source, path.join(dir, relative), constants.COPYFILE_EXCL);
          media.set(relative, Date.now());
          track = { ...track, labels: { ...track.labels, [relative]: path.basename(source).slice(0, 200) } };
          if (kind === 'image') images.push(relative);
        }
        const files = trackFiles(media, seconds);
        // An import for one shot only adds the picture: the editor then places it, asking first when clips were made from the old one.
        if (edit.index !== undefined && !edit.anchor) {
          images.forEach((file, offset) => {
            track = applyTrackEdit(track, { type: 'add-anchor', index: edit.index! + offset, file }, files);
          });
        }
        await saveTrack(dir, track, previous ?? current);
        return { track, imported: images, message: edit.anchor ? undefined : picked.length === 1 ? 'Added to the library.' : `Added ${String(picked.length)} files to the library.` };
      }
      case 'convert': {
        if (previous) return { track: previous };
        if (!options.board) throw new TrackEditError('There is no storyboard to open.');
        for (const shot of options.board.shots) {
          if (shot.clip && media.has(shot.clip)) seconds.set(shot.clip, await probeSeconds(path.join(dir, shot.clip)));
        }
        const track = trackFromBoard(options.board, trackFiles(media, seconds), Date.now());
        await saveTrack(dir, track, null);
        return { track };
      }
      case 'export': {
        const stale = exportCheck(current).stale;
        const file = await exportFilm(dir, current, media);
        const track = { ...current, exports: [...current.exports, file] };
        await saveTrack(dir, track, null);
        return { track, message: stale.length > 0 ? `Exported ${file}. ${stale.join(', ')} still use${stale.length === 1 ? 's' : ''} an earlier image.` : `Exported ${file}.` };
      }
      case 'trim': {
        const anchor = current.anchors.find((entry) => entry.id === edit.anchor);
        const use = anchor?.clip?.use;
        if (!use || !media.has(use)) throw new TrackEditError('There is no clip to trim yet.');
        const frame = await saveFrame(dir, use, edit.end);
        media.set(frame, Date.now());
        const track = applyTrackEdit(current, edit, trackFiles(media, seconds), { frame });
        await saveTrack(dir, track, previous ?? current);
        return { track };
      }
      case 'add-version': {
        if (media.has(edit.file)) seconds.set(edit.file, await probeSeconds(path.join(dir, edit.file)));
        break;
      }
      default:
        break;
    }
    const track = applyTrackEdit(current, edit, trackFiles(media, seconds));
    await saveTrack(dir, track, previous ?? current);
    return { track };
  });
}

/**
 * Takes in files the agent announced in deliveries/*.json: each becomes a new
 * version on the track. Read deliveries move to deliveries/done, unreadable
 * ones to deliveries/failed, so none is applied twice. Each one is saved to
 * the track before it moves, so a delivery that moved is never lost.
 */
export function ingestStudioDeliveries(dir: string, now: number = Date.now()): Promise<string[]> {
  return queue.run(async () => {
    const inbox = path.join(dir, STUDIO_DELIVERIES_DIR);
    let names: string[];
    try {
      if ((await lstat(inbox)).isSymbolicLink()) return [];
      names = (await readdir(inbox, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.')).map((entry) => entry.name).sort().slice(0, 50);
    } catch {
      return [];
    }
    if (names.length === 0) return [];
    // A new project has no track.json until its first edit; one with a storyboard waits to be opened in the editor.
    const onDisk = await readStudioTrack(dir);
    let track = onDisk ?? (await exists(path.join(dir, STUDIO_BOARD_FILE)) ? null : emptyStudioTrack());
    let saved = onDisk;
    const media = await scanStudioMedia(dir);
    const notices: string[] = [];
    for (const name of names) {
      let applied = false;
      let problem = 'could not be read';
      try {
        const raw = await readJson(path.join(inbox, name), 64 * 1024);
        const agentEdit = parseStudioAgentEdit(raw);
        const delivery = agentEdit ? null : parseStudioDelivery(raw);
        if (agentEdit) {
          if (!track) {
            problem = 'is an edit, and this project is still an old storyboard: open it in the editor first';
          } else {
            try {
              // An edit the user asked for in chat is undoable like the user's own.
              const next = applyTrackEdit(track, agentEdit, trackFiles(media, new Map()));
              await saveTrack(dir, next, track);
              track = next;
              saved = next;
              applied = true;
            } catch (err) {
              problem = `asks for an edit the track refused (${err instanceof Error ? err.message : String(err)})`;
            }
          }
        } else if (!delivery) problem = studioAgentEditProblem(raw) ?? 'is not a clip, image or edit delivery';
        else if (!media.has(delivery.file)) problem = `names ${delivery.file}, which is not in the project folder`;
        else if (track) {
          const seconds = delivery.kind === 'clip' ? await probeSeconds(path.join(dir, delivery.file)) : null;
          const next = applyStudioDelivery(track, delivery, seconds, now);
          if (next) {
            track = next;
            applied = true;
          } else {
            problem = `is for ${delivery.kind === 'clip' ? `clip ${delivery.clip}` : `anchor ${delivery.anchor}`}, which is no longer on the track`;
          }
        }
        // What the agent paid for is spent even when the file has no place on the track.
        if (!applied && delivery && delivery.usd !== null && track) {
          track = { ...track, spent: [...track.spent, { label: `Not placed: ${delivery.file}`, detail: delivery.model, usd: delivery.usd }] };
        }
      } catch {
        applied = false;
      }
      // A delivered file is not an edit of the user's, so Undo never takes it away.
      if (track && track !== saved) {
        await saveTrack(dir, track, null);
        saved = track;
      }
      if (!applied) notices.push(`${STUDIO_DELIVERIES_DIR}/${name} ${problem}. It was moved to ${STUDIO_DELIVERIES_DIR}/failed.`);
      await mediaDir(dir, `${STUDIO_DELIVERIES_DIR}/${applied ? 'done' : 'failed'}`);
      await rename(path.join(inbox, name), path.join(inbox, applied ? 'done' : 'failed', `${String(now)}-${name}`));
    }
    return notices;
  });
}

