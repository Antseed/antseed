import { dialog, ipcMain, shell } from 'electron';
import type { TrackEdit } from '../../shared/studio-track.js';
import { editStudioTrack, ingestStudioDeliveries, studioFolder } from '../studio/track.js';
import type { PiChatEngine } from '../chat/engine-types.js';
import { normalizeServiceId } from '../chat/normalize.js';
import {
  createStudioProject,
  getStudioProject,
  getStudioProjectBoard,
  getStudioProjectSummary,
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

  // Every other Studio call refuses while Studio is off, and answers a failure with its error.
  const handle = <T>(channel: string, run: (payload: T | undefined) => Promise<unknown>) => {
    ipcMain.handle(channel, async (_event, payload: T | undefined) => {
      if (!studioPreviewEnabled()) return { ok: false, error: STUDIO_PREVIEW_OFF };
      try {
        return await run(payload);
      } catch (err) {
        return errorResult(err);
      }
    });
  };

  handle('studio:edit', async (payload: { id?: unknown; edit?: TrackEdit } | undefined) => {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const edit = payload?.edit;
    // Only what the edit needs: the project must exist, and only Convert reads its storyboard.
    if (!edit || typeof edit !== 'object' || typeof edit.type !== 'string' || !(await getStudioProjectSummary(id))) return { ok: false, error: 'Project not found.' };
    if (edit.type === 'dismiss-notices') {
      // No track: the editor keeps the one it shows, even when track.json cannot be read just now.
      notices.delete(id);
      return { ok: true };
    }
    const dir = await studioFolder(id, STUDIO_DIR);
    const picked = edit.type === 'import'
      ? (await dialog.showOpenDialog({
        properties: edit.anchor ? ['openFile'] : ['openFile', 'multiSelections'],
        filters: [edit.anchor || edit.index !== undefined
          ? { name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp'] }
          : { name: 'Pictures and videos', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mov', 'm4v', 'webm'] }],
      })).filePaths
      : [];
    const board = edit.type === 'convert' ? await getStudioProjectBoard(id) ?? undefined : undefined;
    const result = await editStudioTrack(dir, edit, { picked, board });
    return { ok: true, data: result };
  });

  handle('studio:list', async () => ({ ok: true, data: await listStudioProjects() }));

  handle('studio:create', async (payload: { name?: unknown } | undefined) => ({ ok: true, data: await createStudioProject(payload?.name) }));

  handle('studio:get', async (payload: { id?: unknown } | undefined) => {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const folder = studioProjectDir(id);
    if (folder) {
      const fresh = await ingestStudioDeliveries(await studioFolder(id, STUDIO_DIR)).catch(() => []);
      if (fresh.length > 0) notices.set(id, [...(notices.get(id) ?? []), ...fresh].slice(-10));
    }
    const detail = await getStudioProject(id);
    return detail ? { ok: true, data: { ...detail, notices: notices.get(id) ?? [] } } : { ok: false, error: 'Project not found.' };
  });

  handle('studio:project-chat', async (payload: { id?: unknown; model?: unknown } | undefined) => {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const summary = await getStudioProjectSummary(id);
    const folder = studioProjectDir(id);
    if (!summary || !folder) return { ok: false, error: 'Project not found.' };
    const existing = summary.conversationId;
    if (existing && await engine.hasConversation(existing)) return { ok: true, conversationId: existing };
    const model = normalizeServiceId(payload?.model);
    if (!model) return { ok: true, conversationId: null };
    const conversation = await engine.createConversation(model, folder);
    await setStudioProjectConversation(id, conversation.id);
    return { ok: true, conversationId: conversation.id };
  });

  handle('studio:open-folder', async (payload: { id?: unknown } | undefined) => {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const folder = studioProjectDir(id);
    if (!folder || !(await getStudioProjectSummary(id))) return { ok: false, error: 'Project not found.' };
    const failure = await shell.openPath(folder);
    return failure ? { ok: false, error: failure } : { ok: true };
  });
}
