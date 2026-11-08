import { expect, it } from 'vitest';
import type { ContentBlock } from '../../ui/components/chat/chat-shared';
import { extractInlineThinkBlocks, syncInlineThink } from './inline-thinking';

it('moves a complete <think> section into a thinking block before the text', () => {
  const blocks: ContentBlock[] = [{ type: 'text', text: '<think>plan it</think>\n\nThe answer', renderKey: 't1' }];
  extractInlineThinkBlocks(blocks);
  expect(blocks.map((block) => [block.type, block.type === 'thinking' ? block.thinking : block.text])).toEqual([
    ['thinking', 'plan it'],
    ['text', 'The answer'],
  ]);
  expect(blocks[0]!.streaming).toBe(false);
});

it('keeps streaming thinking open until the closing tag arrives in a later delta', () => {
  const text: ContentBlock = { type: 'text', text: '<think>first ', renderKey: 't1' };
  const blocks: ContentBlock[] = [text];
  syncInlineThink(blocks, text);
  expect(blocks[0]).toMatchObject({ type: 'thinking', thinking: 'first ', streaming: true });
  expect(text.text).toBe('');

  text.text = 'second</think> Done';
  syncInlineThink(blocks, text);
  expect(blocks[0]).toMatchObject({ type: 'thinking', thinking: 'first second', streaming: false });
  expect(text.text).toBe('Done');
});

it('a stored reply cut off inside its thinking ends that block', () => {
  const blocks: ContentBlock[] = [{ type: 'text', text: '<think>never closed', renderKey: 't1' }];
  extractInlineThinkBlocks(blocks);
  expect(blocks[0]).toMatchObject({ type: 'thinking', thinking: 'never closed', streaming: false });
});
