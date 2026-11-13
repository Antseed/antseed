/**
 * Inline reasoning: models such as DeepSeek and Qwen put their thinking in the
 * reply text as `<think>…</think>`. These move it into a thinking block, in
 * place, both while a reply streams and for a stored one.
 */
import type { ChatMessage, ContentBlock } from '../../ui/components/chat/chat-shared';

// Move any leading <think>...[</think>] segment out of a text block and into
// an adjacent thinking block, for models (DeepSeek, Qwen) that emit their
// reasoning as inline XML. Handles both the streaming case (no closing tag
// yet) and the committed case.
export function syncInlineThink(blocks: ContentBlock[], textBlock: ContentBlock): void {
  const CLOSE_TAG = '</think>';
  const OPEN_TAG = '<think>';
  const openThink = findOpenInlineThink(blocks, textBlock);
  if (openThink) {
    const pending = String(textBlock.text || '');
    if (pending.length === 0) return;
    const combined = `${String(openThink.thinking || '')}${pending}`;
    textBlock.text = '';
    const closeIdx = combined.indexOf(CLOSE_TAG);
    if (closeIdx === -1) {
      openThink.thinking = combined;
    } else {
      openThink.thinking = combined.slice(0, closeIdx).trim();
      openThink.streaming = false;
      textBlock.text = combined.slice(closeIdx + CLOSE_TAG.length).replace(/^\s*/, '');
    }
    return;
  }
  const raw = String(textBlock.text || '');
  if (!raw.startsWith(OPEN_TAG)) return;
  const body = raw.slice(OPEN_TAG.length);
  const closeIdx = body.indexOf(CLOSE_TAG);
  const textIdx = blocks.indexOf(textBlock);
  const thinkingBlock: ContentBlock = {
    type: 'thinking',
    thinking: '',
    streaming: true,
    // `inlineThink` marks it as moved out of the text: a stored reply's text
    // block has no render key, so the key alone can't say so.
    details: { inlineThink: true, inlineThinkFor: textBlock.renderKey },
  };
  blocks.splice(textIdx >= 0 ? textIdx : blocks.length, 0, thinkingBlock);
  if (closeIdx === -1) {
    thinkingBlock.thinking = body;
    textBlock.text = '';
  } else {
    thinkingBlock.thinking = body.slice(0, closeIdx).trim();
    thinkingBlock.streaming = false;
    textBlock.text = body.slice(closeIdx + CLOSE_TAG.length).replace(/^\s*/, '');
  }
}

export function findOpenInlineThink(blocks: ContentBlock[], textBlock: ContentBlock): ContentBlock | undefined {
  const textIdx = blocks.indexOf(textBlock);
  const prev = textIdx > 0 ? blocks[textIdx - 1] : undefined;
  if (
    prev
    && prev.type === 'thinking'
    && prev.streaming
    && prev.details
    && (prev.details as Record<string, unknown>).inlineThinkFor === textBlock.renderKey
  ) {
    return prev;
  }
  return undefined;
}

export function extractInlineThinkBlocks(blocks: ContentBlock[]): void {
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block?.type === 'text') syncInlineThink(blocks, block);
  }
  for (const block of blocks) {
    if (block?.type === 'thinking' && block.details && (block.details as Record<string, unknown>).inlineThink === true) {
      block.streaming = false;
    }
  }
}

export function normalizeInlineThinkInMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return message;
    const content = (message.content as ContentBlock[]).map((b) => ({ ...b }));
    extractInlineThinkBlocks(content);
    return { ...message, content };
  });
}
