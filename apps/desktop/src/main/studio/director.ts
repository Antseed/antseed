import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { emptyDesk, type Desk, type DeskAction } from '../../shared/director.js';
import { studioMediaKind } from '../../shared/studio.js';
import { getStudioProject, resolveStudioFile, STUDIO_DIR, studioProjectDir } from './store.js';
import { createSerialQueue } from '../serial-queue.js';

const run = promisify(execFile);
const queue = createSerialQueue();
async function folder(id: string, root: string) {
  const dir = studioProjectDir(id, root);
  if (!dir || await realpath(dir) !== path.join(await realpath(root), id) || (await lstat(dir)).isSymbolicLink()) throw Error('Invalid project folder');
  return dir;
}
export async function readDesk(id: string, root = STUDIO_DIR): Promise<Desk> {
  const file = path.join(await folder(id, root), 'director.json');
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 1024 * 1024) throw Error('Invalid director.json');
    const d = JSON.parse(await readFile(file, 'utf8')) as Desk;
    if (!Array.isArray(d.order) || !d.edits || !Array.isArray(d.shelf) || !Array.isArray(d.lessons)) throw Error('Invalid director.json');
    return d;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyDesk(); throw e; }
}
export function changeDesk(id: string, action: DeskAction, picked: string[] = [], root = STUDIO_DIR) {
  return queue.run(async () => {
    const dir = await folder(id, root);
    const project = await getStudioProject(id, root);
    if (!project) throw Error('Project not found');
    const d = await readDesk(id, root);
    const shots = [...project.board.shots, ...(d.importedShots ?? []).map(s => ({ id: s.id, clip: studioMediaKind(s.path) === 'video' ? s.path : null, still: studioMediaKind(s.path) === 'image' ? s.path : null }))];
    const shot = 'shot' in action ? shots.find(s => s.id === action.shot) : undefined;
    if ('shot' in action && (!shot || Object.hasOwn(Object.prototype, shot.id))) throw Error('Unknown shot');
    const e = shot ? d.edits[shot.id] ??= { takes: [] } : undefined;
    if (e?.locked && action.type !== 'lock') throw Error('Unlock the shot first');
    const saveMedia = async (sub: string, extension: string) => {
      const dest = path.join(dir, sub);
      await mkdir(dest, { recursive: true });
      if (await realpath(dest) !== path.join(await realpath(dir), sub)) throw Error('Invalid media directory');
      return `${sub}/${randomUUID()}${extension}`;
    };
    switch (action.type) {
      case 'import':
        for (const source of picked.slice(0, 20)) {
          if (!studioMediaKind(source) || !(await stat(source)).isFile()) throw Error('Choose a picture or video');
          const rel = await saveMedia('references', path.extname(source).toLowerCase());
          await copyFile(source, path.join(dir, rel), constants.COPYFILE_EXCL);
          d.shelf.push({ path: rel, label: path.basename(source), role: 'Reference' });
        } break;
      case 'place': {
        const ref = d.shelf.find(r => r.path === action.source);
        if (!ref) throw Error('Reference not found');
        (d.importedShots ??= []).push({ id: `import-${randomUUID().slice(0,8)}`, path: ref.path, label: ref.label }); break;
      }
      case 'role': {
        const ref = d.shelf.find(r => r.path === action.source);
        if (!ref) throw Error('Reference not found');
        ref.role = action.role.trim().slice(0, 200); break;
      }
      case 'order':
        if (!Array.isArray(action.ids) || new Set(action.ids).size !== shots.length || action.ids.length !== shots.length || !shots.every(s => action.ids.includes(s.id))) throw Error('Shot list changed; try again');
        d.order = action.ids; break;
      case 'hold':
        if (!Number.isFinite(action.seconds) || action.seconds < 0.1 || action.seconds > 600) throw Error('Use a duration between 0.1 and 600 seconds');
        e!.hold = action.seconds; break;
      case 'lock': e!.locked = !e!.locked; break;
      case 'undo': [e!.keeper, e!.previous] = [e!.previous, e!.keeper]; break;
      case 'add': case 'trim': case 'keep': {
        const rel = action.source;
        const valid = rel === shot!.clip || rel === shot!.still || project.board.shots.find(s => s.id === shot!.id)?.alternatives?.includes(rel) || e!.takes.some(t => t.path === rel) || d.shelf.some(r => r.path === rel);
        const file = valid && await resolveStudioFile(id, rel, root);
        if (!file) throw Error('Media unavailable');
        if (action.type === 'trim') {
          if (studioMediaKind(rel) !== 'video' || !Number.isFinite(action.end) || action.end < 0.1 || action.end > 600) throw Error('Pause at the end of the desired clip');
          const target = await saveMedia('takes', '.mp4');
          await run('ffmpeg', ['-nostdin','-v','error','-protocol_whitelist','file','-f',path.extname(file).toLowerCase() === '.webm' ? 'matroska' : 'mov','-i',file,'-t',String(action.end),'-map','0:v:0','-map','0:a:0?','-c:v','libx264','-c:a','aac','-movflags','+faststart','-n',path.join(dir,target)], { timeout: 180000 });
          e!.takes.push({ path: target, label: `Trim to ${action.end.toFixed(2)} s` });
        } else if (action.type === 'keep') {
          e!.previous = e!.keeper ?? shot!.clip ?? shot!.still ?? undefined; e!.keeper = rel;
        } else if (!e!.takes.some(t => t.path === rel)) e!.takes.push({ path: rel, label: d.shelf.find(r => r.path === rel)?.label ?? path.basename(rel) });
        break;
      }
      case 'teach': {
        const rule = action.lesson.trim().slice(0, 1000); if (!rule) throw Error('Enter a direction first');
        if (!d.lessons.includes(rule)) d.lessons.push(rule); break;
      }
      case 'forget': d.lessons = d.lessons.filter(rule => rule !== action.lesson); break;
      default: throw Error('Unknown edit');
    }
    const tmp = path.join(dir, `${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(d, null, 2), { flag: 'wx', mode: 0o600 });
    await rename(tmp, path.join(dir, 'director.json')); return d;
  });
}
