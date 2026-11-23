import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ANTSEED_HOME_DIR } from '../chat/paths.js';
import {
  emptyStudioBoard,
  isStudioProjectId,
  normalizeStudioPath,
  parseStudioBoard,
  STUDIO_BOARD_FILE,
  STUDIO_PROJECT_FILE,
  studioBoardFiles,
  studioMediaKind,
  type StudioBoard,
  type StudioProjectDetail,
  type StudioProjectSummary,
} from '../../shared/studio.js';
import { emptyStudioTrack, STUDIO_DELIVERIES_DIR, STUDIO_TRACK_FILE, type StudioTrack } from '../../shared/studio-track.js';
import { addTrackFiles, readStudioTrack, resolveProjectFile, scanStudioMedia, studioCanUndo, studioLibrary, studioMediaTools } from './track.js';

export const STUDIO_DIR = path.join(ANTSEED_HOME_DIR, 'studio');

const MAX_BOARD_BYTES = 2 * 1024 * 1024;

const PROJECT_AGENTS_FILE = `# Antseed Studio project

This folder is a project in Antseed Desktop's Studio. The user edits the film in \`${STUDIO_TRACK_FILE}\` beside this chat: anchor images in order, with a clip between each pair.

Before you do anything here, read the \`antseed-studio\` skill (its SKILL.md) and follow it. Read \`${STUDIO_TRACK_FILE}\` but never write it, nor \`${STUDIO_PROJECT_FILE}\`: hand every file you make back through \`${STUDIO_DELIVERIES_DIR}/\` as the skill says.
`;

type ProjectFile = { name: string; createdAt: number; conversationId: string | null };

export function slugifyStudioName(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return slug || 'project';
}

function projectDir(id: string, root: string): string {
  return path.join(root, id);
}

async function readProjectFile(id: string, root: string): Promise<ProjectFile | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(projectDir(id, root), STUDIO_PROJECT_FILE), 'utf8')) as Record<string, unknown>;
    const name = typeof parsed['name'] === 'string' && parsed['name'].trim() ? parsed['name'].trim().slice(0, 120) : id;
    const createdAt = typeof parsed['createdAt'] === 'number' && Number.isFinite(parsed['createdAt']) ? parsed['createdAt'] : 0;
    const conversationId = typeof parsed['conversationId'] === 'string' && parsed['conversationId'] ? parsed['conversationId'] : null;
    return { name, createdAt, conversationId };
  } catch {
    return null;
  }
}

async function writeProjectFile(id: string, root: string, file: ProjectFile): Promise<void> {
  const body = { version: 1, name: file.name, createdAt: file.createdAt, ...(file.conversationId ? { conversationId: file.conversationId } : {}) };
  await writeFile(path.join(projectDir(id, root), STUDIO_PROJECT_FILE), `${JSON.stringify(body, null, 2)}\n`);
}

async function readBoard(id: string, root: string): Promise<{ board: StudioBoard; error: string | null; modifiedAt: number }> {
  const boardPath = path.join(projectDir(id, root), STUDIO_BOARD_FILE);
  let modifiedAt = 0;
  try {
    const info = await stat(boardPath);
    modifiedAt = info.mtimeMs;
    if (info.size > MAX_BOARD_BYTES) return { board: emptyStudioBoard(), error: `${STUDIO_BOARD_FILE} is too large to show`, modifiedAt };
  } catch {
    return { board: emptyStudioBoard(), error: null, modifiedAt };
  }
  try {
    return { board: parseStudioBoard(JSON.parse(await readFile(boardPath, 'utf8'))), error: null, modifiedAt };
  } catch {
    return { board: emptyStudioBoard(), error: `${STUDIO_BOARD_FILE} is not valid JSON`, modifiedAt };
  }
}

export async function resolveStudioFile(id: string, filePath: unknown, root: string = STUDIO_DIR): Promise<string | null> {
  const relative = normalizeStudioPath(filePath);
  if (!isStudioProjectId(id) || !relative || !studioMediaKind(relative)) return null;
  return (await resolveProjectFile(projectDir(id, root), relative))?.file ?? null;
}

async function fileVersion(id: string, file: string, root: string): Promise<number | null> {
  const resolved = await resolveStudioFile(id, file, root);
  if (!resolved) return null;
  try {
    return Math.floor((await stat(resolved)).mtimeMs);
  } catch {
    return null;
  }
}

async function readTrackSafely(id: string, root: string): Promise<{ track: StudioTrack | null; error: string | null; modifiedAt: number }> {
  const dir = projectDir(id, root);
  let modifiedAt = 0;
  try {
    modifiedAt = (await stat(path.join(dir, STUDIO_TRACK_FILE))).mtimeMs;
    return { track: await readStudioTrack(dir), error: null, modifiedAt };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { track: null, error: null, modifiedAt };
    return { track: emptyStudioTrack(), error: `${STUDIO_TRACK_FILE} could not be read`, modifiedAt };
  }
}

async function readProject(id: string, root: string): Promise<{ summary: StudioProjectSummary; board: StudioBoard; boardError: string | null; track: StudioTrack | null; trackError: string | null } | null> {
  const project = await readProjectFile(id, root);
  if (!project) return null;
  const { board, error, modifiedAt: boardModifiedAt } = await readBoard(id, root);
  const read = await readTrackSafely(id, root);
  const { error: trackError, modifiedAt: trackModifiedAt } = read;
  // A project without a track and without a storyboard is new: it opens in the track editor.
  const track = read.track ?? (board.shots.length === 0 && !error ? emptyStudioTrack() : null);
  const modifiedAt = Math.max(boardModifiedAt, trackModifiedAt);
  const stills = track ? track.anchors.map((anchor) => anchor.image) : board.shots.map((shot) => shot.still);
  let cover: StudioProjectSummary['cover'] = null;
  for (const still of stills) {
    const version = still ? await fileVersion(id, still, root) : null;
    if (still && version !== null) {
      cover = { path: still, version };
      break;
    }
  }
  return {
    summary: {
      id,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: Math.max(project.createdAt, Math.floor(modifiedAt)),
      conversationId: project.conversationId,
      shotCount: track ? track.anchors.length : board.shots.length,
      cover,
    },
    board,
    boardError: error,
    track,
    trackError,
  };
}

export async function listStudioProjects(root: string = STUDIO_DIR): Promise<StudioProjectSummary[]> {
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  const projects = await Promise.all(names.filter(isStudioProjectId).map((id) => readProject(id, root)));
  return projects
    .filter((project) => project !== null)
    .map((project) => project.summary)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

/** The project's storyboard from before the track editor, for opening it there, or null when there is no such project. */
export async function getStudioProjectBoard(id: string, root: string = STUDIO_DIR): Promise<StudioBoard | null> {
  if (!isStudioProjectId(id) || !(await readProjectFile(id, root))) return null;
  return (await readBoard(id, root)).board;
}

/** Whether a project is there, read from its small project file alone. */
export async function studioProjectExists(id: string, root: string = STUDIO_DIR): Promise<boolean> {
  return isStudioProjectId(id) && (await readProjectFile(id, root)) !== null;
}

/** The project's name, chat and cover, without reading its media library. */
export async function getStudioProjectSummary(id: string, root: string = STUDIO_DIR): Promise<StudioProjectSummary | null> {
  if (!isStudioProjectId(id)) return null;
  return (await readProject(id, root))?.summary ?? null;
}

export async function getStudioProject(id: string, root: string = STUDIO_DIR): Promise<StudioProjectDetail | null> {
  if (!isStudioProjectId(id)) return null;
  const project = await readProject(id, root);
  if (!project) return null;
  const media = await scanStudioMedia(projectDir(id, root));
  await addTrackFiles(projectDir(id, root), media, project.track);
  const files: Record<string, number> = Object.fromEntries(media);
  await Promise.all(studioBoardFiles(project.board).filter((file) => !(file in files)).map(async (file) => {
    const version = await fileVersion(id, file, root);
    if (version !== null) files[file] = version;
  }));
  return {
    project: project.summary,
    folder: projectDir(id, root),
    board: project.board,
    boardError: project.boardError,
    track: project.track,
    trackError: project.trackError,
    library: studioLibrary(project.track, media),
    notices: [],
    canUndo: project.track ? await studioCanUndo(projectDir(id, root)) : false,
    files,
    mediaTools: await studioMediaTools(),
  };
}

export async function createStudioProject(name: unknown, root: string = STUDIO_DIR, now: number = Date.now()): Promise<StudioProjectSummary> {
  const cleanName = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').slice(0, 120) : '';
  if (!cleanName) throw new Error('Give the project a name.');
  await mkdir(root, { recursive: true });
  const base = slugifyStudioName(cleanName);
  for (let attempt = 1; attempt <= 200; attempt += 1) {
    const id = attempt === 1 ? base : `${base.slice(0, 44)}-${String(attempt)}`;
    try {
      await mkdir(projectDir(id, root));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    await writeProjectFile(id, root, { name: cleanName, createdAt: now, conversationId: null });
    await writeFile(path.join(projectDir(id, root), 'AGENTS.md'), PROJECT_AGENTS_FILE);
    return { id, name: cleanName, createdAt: now, updatedAt: now, conversationId: null, shotCount: 0, cover: null };
  }
  throw new Error('Too many projects share this name. Choose another name.');
}

export function studioProjectDir(id: string, root: string = STUDIO_DIR): string | null {
  return isStudioProjectId(id) ? projectDir(id, root) : null;
}

export function studioProjectIdForFolder(folder: string | undefined, root: string = STUDIO_DIR): string | null {
  if (!folder) return null;
  const id = path.relative(root, path.resolve(folder));
  return isStudioProjectId(id) ? id : null;
}

export async function setStudioProjectConversation(id: string, conversationId: string, root: string = STUDIO_DIR): Promise<void> {
  if (!isStudioProjectId(id)) throw new Error('Project not found.');
  const project = await readProjectFile(id, root);
  if (!project) throw new Error('Project not found.');
  await writeProjectFile(id, root, { ...project, conversationId });
}
