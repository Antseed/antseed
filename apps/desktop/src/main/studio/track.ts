import { createHash, randomUUID } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { STUDIO_BOARD_FILE, STUDIO_MEDIA_TOOLS_MISSING, studioBoardFiles, studioMediaKind, type StudioBoard } from '../../shared/studio.js';
import {
  addStudioExport,
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
  type IngestRecord,
  type StudioEditResult,
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
const MAX_HISTORY_BYTES = MAX_TRACK_BYTES * 4;
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

async function writeAtomic(dir: string, name: string, content: string): Promise<void> {
  const tmp = path.join(dir, `.${randomUUID()}.tmp`);
  await writeFile(tmp, content, { flag: 'wx', mode: 0o600 });
  await rename(tmp, path.join(dir, name));
}

export const STUDIO_TRACK_TOO_LARGE = 'This change was not saved: the track would grow past the 2 MB the app can read back. Remove shots you no longer need, then try again.';

class TrackTooLargeError extends TrackEditError {}

/** track.json as it is written, refused when a read would not take it back, so the file on disk stays the last track that fits. */
function trackJson(track: StudioTrack): string {
  const json = `${JSON.stringify(track, null, 2)}\n`;
  if (Buffer.byteLength(json) > MAX_TRACK_BYTES) throw new TrackTooLargeError(STUDIO_TRACK_TOO_LARGE);
  return json;
}

/** The newest snapshots, at most HISTORY_LIMIT, that fit the size readHistory takes; the oldest go first. */
function historyJson(snapshots: unknown[]): string {
  const kept: string[] = [];
  let bytes = '[]\n'.length;
  for (let index = snapshots.length - 1; index >= 0 && kept.length < HISTORY_LIMIT; index -= 1) {
    const entry = JSON.stringify(snapshots[index]);
    const size = Buffer.byteLength(entry) + (kept.length > 0 ? 1 : 0);
    if (bytes + size > MAX_HISTORY_BYTES) break;
    kept.push(entry);
    bytes += size;
  }
  return `[${kept.reverse().join(',')}]\n`;
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
    const raw = await readJson(path.join(dir, HISTORY_FILE), MAX_HISTORY_BYTES);
    return Array.isArray(raw) ? raw.slice(-HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

async function saveTrack(dir: string, track: StudioTrack, previous: StudioTrack | null): Promise<void> {
  const json = trackJson(track);
  if (previous) await writeAtomic(dir, HISTORY_FILE, historyJson([...await readHistory(dir), previous]));
  await writeAtomic(dir, STUDIO_TRACK_FILE, json);
}

/** A file inside the project folder, by its project path: its real path and time, or null when it is missing or leads outside the folder. */
export async function resolveProjectFile(dir: string, relative: string): Promise<{ file: string; modifiedAt: number } | null> {
  try {
    const [realDir, realFile] = await Promise.all([realpath(dir), realpath(path.join(dir, relative))]);
    const within = path.relative(realDir, realFile);
    if (!within || within.startsWith('..') || path.isAbsolute(within)) return null;
    const info = await stat(realFile);
    return info.isFile() ? { file: realFile, modifiedAt: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** Every file the track uses or used, and the files an edit, a delivery or a storyboard names. */
function namedFiles(track: StudioTrack | null, extra: readonly unknown[]): string[] {
  const used = track ? libraryUseOf(track) : null;
  return [...(used?.inUse ?? []), ...(used?.earlier ?? []), ...extra.filter((file): file is string => typeof file === 'string')];
}

/**
 * The library scan stops at its depth and count limits, so it never decides that a file is missing:
 * each file the track or a request names that the scan did not reach is looked up on its own.
 */
async function addNamedFiles(dir: string, media: Map<string, number>, files: readonly string[]): Promise<void> {
  for (const file of new Set(files)) {
    if (media.has(file) || !studioMediaKind(file)) continue;
    const found = await resolveProjectFile(dir, file);
    if (found) media.set(file, found.modifiedAt);
  }
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

/** Applies one edit to a project's track, one edit at a time across all projects. */
export function editStudioTrack(dir: string, edit: TrackEdit, options: { picked?: string[]; board?: StudioBoard } = {}): Promise<StudioEditResult> {
  return queue.run(async () => {
    const previous = await readStudioTrack(dir);
    const current = previous ?? emptyStudioTrack();
    const media = await scanStudioMedia(dir);
    await addNamedFiles(dir, media, namedFiles(current, ['file' in edit ? edit.file : null, ...(edit.type === 'convert' && options.board ? studioBoardFiles(options.board) : [])]));
    const seconds = new Map<string, number | null>();
    switch (edit.type) {
      case 'undo': {
        const history = await readHistory(dir);
        const last = history.pop();
        if (last === undefined) throw new TrackEditError('Nothing to undo.');
        const restored = undoTo(parseStudioTrack(last), current);
        const json = trackJson(restored);
        await writeAtomic(dir, HISTORY_FILE, historyJson(history));
        await writeAtomic(dir, STUDIO_TRACK_FILE, json);
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
          track = { ...track, labels: { ...track.labels, [relative]: path.basename(source).trim().slice(0, 200) } };
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
        const track = addStudioExport(current, file);
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

/** A delivery file and its key: its name, time and content, so a file written again under the same name is new. */
async function readDelivery(file: string): Promise<{ raw: unknown; key: string }> {
  const info = await lstat(file);
  if (!info.isFile() || info.size > 64 * 1024) throw new Error(`${path.basename(file)} is not readable`);
  const content = await readFile(file);
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  return { raw: JSON.parse(content.toString('utf8')) as unknown, key: `${path.basename(file)}:${String(Math.floor(info.mtimeMs))}:${hash}` };
}

/**
 * Takes in files the agent announced in deliveries/*.json: each becomes a new
 * version on the track. Read deliveries move to deliveries/done, unreadable
 * ones to deliveries/failed, so none is applied twice. Each one is saved to
 * the track, with its key, before it moves: a delivery that moved is never
 * lost, and one that could not be moved is only moved on the next read.
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
    await addNamedFiles(dir, media, namedFiles(track, []));
    const notices: string[] = [];
    for (const name of names) {
      const before = track;
      let applied = false;
      let problem = 'could not be read';
      let key: string | null = null;
      // An edit the user asked for in chat is undoable like the user's own; a delivered file is not an edit of the user's, so Undo never takes it away.
      let undoable = false;
      let taken: IngestRecord | undefined;
      try {
        const read = await readDelivery(path.join(inbox, name));
        key = read.key;
        taken = track?.ingested.find((entry) => entry.key === read.key);
        const raw = read.raw;
        const agentEdit = taken ? null : parseStudioAgentEdit(raw);
        const delivery = taken || agentEdit ? null : parseStudioDelivery(raw);
        if (delivery) await addNamedFiles(dir, media, [delivery.file]);
        if (taken) {
          // Saved to the track on an earlier read, which could not move it: only the move is left.
          applied = taken.applied;
          problem = 'was not placed on the track';
        } else if (agentEdit) {
          if (!track) {
            problem = 'is an edit, and this project is still an old storyboard: open it in the editor first';
          } else {
            // Only the edit's own refusal sets it aside; a failure to save it leaves it in the inbox.
            try {
              await addNamedFiles(dir, media, namedFiles(null, ['file' in agentEdit ? agentEdit.file : null]));
              track = applyTrackEdit(track, agentEdit, trackFiles(media, new Map()));
              applied = true;
              undoable = true;
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
          // A file's path may be longer than a cost label takes.
          track = { ...track, spent: [...track.spent, { label: `Not placed: ${delivery.file}`.slice(0, 120), detail: delivery.model, usd: delivery.usd }] };
        }
      } catch {
        applied = false;
      }
      if (track && track !== saved) {
        if (key) track = { ...track, ingested: [...track.ingested, { key, applied }].slice(-200) };
        try {
          await saveTrack(dir, track, undoable ? before : null);
          saved = track;
        } catch (error) {
          if (!(error instanceof TrackTooLargeError)) throw error;
          // Taking it in would leave a track no read takes back: it is set aside and the track stays as it was.
          track = before;
          applied = false;
          problem = 'would make the track larger than the app can read back';
        }
      }
      if (!applied) notices.push(`${STUDIO_DELIVERIES_DIR}/${name} ${problem}. It was moved to ${STUDIO_DELIVERIES_DIR}/failed.`);
      await mediaDir(dir, `${STUDIO_DELIVERIES_DIR}/${applied ? 'done' : 'failed'}`);
      await rename(path.join(inbox, name), path.join(inbox, applied ? 'done' : 'failed', `${String(now)}-${name}`));
    }
    return notices;
  });
}
