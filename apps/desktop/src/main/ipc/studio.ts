import { dialog, ipcMain, shell } from 'electron';
import type { TrackEdit } from '../../shared/studio-track.js';
import { editStudioTrack, ingestStudioDeliveries, studioFolder } from '../studio/track.js';
import type { PiChatEngine } from '../chat/engine-types.js';
import { normalizeServiceId } from '../chat/normalize.js';
import {
  createStudioProject,
  getStudioProject,
  listStudioProjects,
  setStudioProjectConversation,
  STUDIO_DIR,
  studioProjectDir,
} from '../studio/store.js';
import { setStudioPreviewEnabled, STUDIO_PREVIEW_OFF, studioPreviewEnabled } from '../studio/preview.js';
import { errorResult } from './results.js';

export function registerStudioIpc(deps: { engine: PiChatEngine }): void {
  const { engine } = deps;
  // Notes about deliveries that could not be applied, shown until the user dismisses them.
  const notices = new Map<string, string[]>();

  ipcMain.handle('studio:get-enabled', () => ({ ok: true, enabled: studioPreviewEnabled() }));

  ipcMain.handle('studio:set-enabled', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return { ok: false, error: 'Expected on or off.' };
    try {
      return { ok: true, enabled: setStudioPreviewEnabled(enabled) };
    } catch (err) {
      return errorResult(err);
    }
  });

  // Every other Studio call refuses while Studio is off.
  const handle = <T>(channel: string, run: (payload: T | undefined) => Promise<unknown>) => {
    ipcMain.handle(channel, (_event, payload: T | undefined) => (studioPreviewEnabled() ? run(payload) : { ok: false, error: STUDIO_PREVIEW_OFF }));
  };

  handle('studio:edit', async (payload: { id?: unknown; edit?: TrackEdit } | undefined) => {
    try {
      const id = typeof payload?.id === 'string' ? payload.id : '';
      const edit = payload?.edit;
      const detail = await getStudioProject(id);
      if (!detail || !edit || typeof edit !== 'object' || typeof edit.type !== 'string') return { ok: false, error: 'Project not found.' };
      const dir = await studioFolder(id, STUDIO_DIR);
      if (edit.type === 'dismiss-notices') {
        notices.delete(id);
        return { ok: true, data: { track: detail.track } };
      }
      const picked = edit.type === 'import'
        ? (await dialog.showOpenDialog({
          properties: edit.anchor ? ['openFile'] : ['openFile', 'multiSelections'],
          filters: [edit.anchor || edit.index !== undefined
            ? { name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp'] }
            : { name: 'Pictures and videos', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mov', 'm4v', 'webm'] }],
        })).filePaths
        : [];
      const result = await editStudioTrack(dir, edit, { picked, board: detail.board });
      return { ok: true, data: result };
    } catch (err) {
      return errorResult(err);
    }
  });

  handle('studio:list', async () => {
    try {
      return { ok: true, data: await listStudioProjects() };
    } catch (err) {
      return errorResult(err);
    }
  });

  handle('studio:create', async (payload: { name?: unknown } | undefined) => {
    try {
      return { ok: true, data: await createStudioProject(payload?.name) };
    } catch (err) {
      return errorResult(err);
    }
  });

  handle('studio:get', async (payload: { id?: unknown } | undefined) => {
    try {
      const id = typeof payload?.id === 'string' ? payload.id : '';
      const folder = studioProjectDir(id);
      if (folder) {
        const fresh = await ingestStudioDeliveries(await studioFolder(id, STUDIO_DIR)).catch(() => []);
        if (fresh.length > 0) notices.set(id, [...(notices.get(id) ?? []), ...fresh].slice(-10));
      }
      const detail = await getStudioProject(id);
      return detail ? { ok: true, data: { ...detail, notices: notices.get(id) ?? [] } } : { ok: false, error: 'Project not found.' };
    } catch (err) {
      return errorResult(err);
    }
  });

  handle('studio:project-chat', async (payload: { id?: unknown; model?: unknown } | undefined) => {
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

  handle('studio:open-folder', async (payload: { id?: unknown } | undefined) => {
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
