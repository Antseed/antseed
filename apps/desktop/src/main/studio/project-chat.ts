import type { PiChatEngine } from '../chat/engine-types.js';
import { normalizeServiceId } from '../chat/normalize.js';
import { createSerialQueue } from '../serial-queue.js';
import { getStudioProjectSummary, setStudioProjectConversation, STUDIO_DIR, studioProjectDir } from './store.js';

export type StudioProjectChat = { ok: true; conversationId: string | null } | { ok: false; error: string };

/**
 * A project's chat: the one it has, or a new one in its folder when a model is given. One request
 * at a time, so a second one sent while the first chat is being made gets that chat, not another.
 */
export function studioProjectChats(engine: Pick<PiChatEngine, 'hasConversation' | 'createConversation'>, root: string = STUDIO_DIR) {
  const queue = createSerialQueue();
  return (id: string, model: unknown): Promise<StudioProjectChat> => queue.run(async () => {
    const summary = await getStudioProjectSummary(id, root);
    const folder = studioProjectDir(id, root);
    if (!summary || !folder) return { ok: false, error: 'Project not found.' };
    const existing = summary.conversationId;
    if (existing && await engine.hasConversation(existing)) return { ok: true, conversationId: existing };
    const service = normalizeServiceId(model);
    if (!service) return { ok: true, conversationId: null };
    const conversation = await engine.createConversation(service, folder);
    await setStudioProjectConversation(id, conversation.id, root);
    return { ok: true, conversationId: conversation.id };
  });
}
