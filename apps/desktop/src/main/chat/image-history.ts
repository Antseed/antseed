import type { ContextEvent, ExtensionAPI } from '@mariozechner/pi-coding-agent';

/**
 * Every turn resends the whole history, images included as base64, so a long
 * chat with screenshots grows past what upstream APIs accept (Anthropic
 * rejects bodies over 32 MB with a 413). Once the images still in context
 * exceed this budget, older images are replaced by a placeholder.
 */
export const IMAGE_HISTORY_BUDGET_BYTES = 16 * 1024 * 1024;
export const IMAGE_CUTOFF_CUSTOM_TYPE = 'antseed:image-cutoff';
export const OMITTED_IMAGE_TEXT = '[Earlier image removed from the conversation to keep the request within upload limits.]';

type ContextMessage = ContextEvent['messages'][number];
type SessionEntryLike = { type: string; customType?: string; data?: unknown };

function contentBlocks(message: ContextMessage): unknown[] {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

function isImageBlock(block: unknown): block is { type: 'image'; data: string } {
  const candidate = block as { type?: unknown; data?: unknown } | null;
  return candidate?.type === 'image' && typeof candidate.data === 'string';
}

function imageBytes(message: ContextMessage): number {
  let bytes = 0;
  for (const block of contentBlocks(message)) {
    if (isImageBlock(block)) bytes += block.data.length;
  }
  return bytes;
}

function timestampOf(message: ContextMessage): number {
  return (message as { timestamp?: number }).timestamp ?? 0;
}

/**
 * The cutoff to save when the images after `cutoff` exceed `budget`: the
 * oldest images are dropped until half the budget remains, so the cutoff
 * moves in large steps and the prompt-cache prefix changes rarely. The latest
 * message always keeps its images. Returns undefined when no move is needed.
 */
export function nextImageCutoff(
  messages: ContextMessage[],
  cutoff: number | undefined,
  budget = IMAGE_HISTORY_BUDGET_BYTES,
): number | undefined {
  const kept = messages.filter((message) => cutoff === undefined || timestampOf(message) > cutoff);
  let remaining = kept.reduce((total, message) => total + imageBytes(message), 0);
  if (remaining <= budget) return undefined;

  let nextCutoff: number | undefined;
  for (const message of kept.slice(0, -1)) {
    if (remaining <= budget / 2) break;
    const bytes = imageBytes(message);
    if (bytes === 0) continue;
    remaining -= bytes;
    nextCutoff = timestampOf(message);
  }
  return nextCutoff;
}

/** Replace the images of messages at or before `cutoff` with a placeholder. */
export function omitImagesBefore(messages: ContextMessage[], cutoff: number): ContextMessage[] {
  return messages.map((message) => {
    if (timestampOf(message) > cutoff || imageBytes(message) === 0) return message;
    const content = contentBlocks(message).map((block) => (
      isImageBlock(block) ? { type: 'text', text: OMITTED_IMAGE_TEXT } : block
    ));
    return { ...message, content } as ContextMessage;
  });
}

export function latestImageCutoff(entries: SessionEntryLike[]): number | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== 'custom' || entry.customType !== IMAGE_CUTOFF_CUSTOM_TYPE) continue;
    const timestamp = (entry.data as { timestamp?: unknown } | undefined)?.timestamp;
    return typeof timestamp === 'number' ? timestamp : undefined;
  }
  return undefined;
}

/**
 * Applies the saved cutoff before every model request and saves a new one
 * when the images in context outgrow the budget. Saving it keeps the trimmed
 * history identical across turns, which keeps prompt caching effective.
 */
export function imageHistoryExtension(pi: ExtensionAPI): void {
  pi.on('context', (event, ctx) => {
    const savedCutoff = latestImageCutoff(ctx.sessionManager.getBranch());
    const nextCutoff = nextImageCutoff(event.messages, savedCutoff);
    if (nextCutoff !== undefined) pi.appendEntry(IMAGE_CUTOFF_CUSTOM_TYPE, { timestamp: nextCutoff });

    const cutoff = nextCutoff ?? savedCutoff;
    if (cutoff === undefined) return undefined;
    return { messages: omitImagesBefore(event.messages, cutoff) };
  });
}
