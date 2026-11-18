import { dialog, ipcMain, shell } from 'electron';
import { changeDesk, readDesk } from '../studio/director.js';
import type { DeskAction } from '../../shared/director.js';
import type { PiChatEngine } from '../chat/engine-types.js';
import { normalizeServiceId } from '../chat/normalize.js';
import {
  createStudioProject,
  getStudioProject,
  listStudioProjects,
  setStudioProjectConversation,
  studioProjectDir,
} from '../studio/store.js';
import { errorResult } from './results.js';

export function registerStudioIpc(deps: { engine: PiChatEngine }): void {
  const { engine } = deps;
  ipcMain.handle('studio:desk', async (_event, id: string, action?: DeskAction) => {
    try {
      if (!action) return { ok: true, data: await readDesk(id) };
      const picked = action.type === 'import' ? (await dialog.showOpenDialog({ properties: ['openFile','multiSelections'], filters: [{ name: 'Pictures and footage', extensions: ['png','jpg','jpeg','webp','gif','mp4','mov','m4v','webm'] }] })).filePaths : [];
      return { ok: true, data: await changeDesk(id, action, picked) };
    } catch (err) { return errorResult(err); }
  });

  ipcMain.handle('studio:list', async () => {
    try {
      return { ok: true, data: await listStudioProjects() };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('studio:create', async (_event, payload: { name?: unknown } | undefined) => {
    try {
      return { ok: true, data: await createStudioProject(payload?.name) };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('studio:get', async (_event, payload: { id?: unknown } | undefined) => {
    try {
      const detail = await getStudioProject(typeof payload?.id === 'string' ? payload.id : '');
      return detail ? { ok: true, data: detail } : { ok: false, error: 'Project not found.' };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('studio:project-chat', async (_event, payload: { id?: unknown; model?: unknown } | undefined) => {
    try {
      const id = typeof payload?.id === 'string' ? payload.id : '';
      const detail = await getStudioProject(id);
      const folder = studioProjectDir(id);
      if (!detail || !folder) return { ok: false, error: 'Project not found.' };
      const existing = detail.project.conversationId;
      if (existing && await engine.hasConversation(existing)) return { ok: true, conversationId: existing };
      const model = normalizeServiceId(payload?.model);
      if (!model) return { ok: true, conversationId: null };
      const conversation = await engine.createConversation(model, folder);
      await setStudioProjectConversation(id, conversation.id);
      return { ok: true, conversationId: conversation.id };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('studio:open-folder', async (_event, payload: { id?: unknown } | undefined) => {
    try {
      const id = typeof payload?.id === 'string' ? payload.id : '';
      const folder = studioProjectDir(id);
      if (!folder || !(await getStudioProject(id))) return { ok: false, error: 'Project not found.' };
      const failure = await shell.openPath(folder);
      return failure ? { ok: false, error: failure } : { ok: true };
    } catch (err) {
      return errorResult(err);
    }
  });
}
