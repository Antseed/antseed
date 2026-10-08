/**
 * Translation between pi-ai's message format and the block format the
 * renderer draws, plus the usage/cost/title totals derived from a thread.
 */

import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolResultMessage,
  Usage,
} from '@mariozechner/pi-ai';
import { isSafeId } from './attachments/store.js';
import { normalizeOptionalNumber, normalizeTokenCount } from './normalize.js';
import type {
  AiChatMessage,
  AiMessageMeta,
  AiUsageTotals,
  ContentBlock,
  ToolResultBlock,
} from './conversation-types.js';

export function toUsage(value: unknown): Usage {
  const usage = (value ?? {}) as Record<string, unknown>;
  const input = normalizeTokenCount(
    usage.inputTokens
    ?? usage.input_tokens
    ?? usage.promptTokens
    ?? usage.prompt_tokens
    ?? usage.input_token_count
    ?? usage.prompt_token_count,
  );
  const output = normalizeTokenCount(
    usage.outputTokens
    ?? usage.output_tokens
    ?? usage.completionTokens
    ?? usage.completion_tokens
    ?? usage.output_token_count
    ?? usage.completion_token_count,
  );
  const cacheRead = normalizeTokenCount(usage.cacheRead ?? usage.cache_read_input_tokens);
  const cacheWrite = normalizeTokenCount(usage.cacheWrite ?? usage.cache_creation_input_tokens);
  const totalTokens = normalizeTokenCount(usage.totalTokens ?? usage.total_tokens) || input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: {
      input: normalizeOptionalNumber((usage.cost as Record<string, unknown> | undefined)?.input) ?? 0,
      output: normalizeOptionalNumber((usage.cost as Record<string, unknown> | undefined)?.output) ?? 0,
      cacheRead: normalizeOptionalNumber((usage.cost as Record<string, unknown> | undefined)?.cacheRead) ?? 0,
      cacheWrite: normalizeOptionalNumber((usage.cost as Record<string, unknown> | undefined)?.cacheWrite) ?? 0,
      total: normalizeOptionalNumber((usage.cost as Record<string, unknown> | undefined)?.total) ?? 0,
    },
  };
}

export function mergeUsage(base: AiUsageTotals, delta: AiUsageTotals): AiUsageTotals {
  return {
    inputTokens: normalizeTokenCount(base.inputTokens) + normalizeTokenCount(delta.inputTokens),
    outputTokens: normalizeTokenCount(base.outputTokens) + normalizeTokenCount(delta.outputTokens),
  };
}

export function ensureUsageShape(base?: Partial<Usage>): Usage {
  const initial = base ?? {};
  const usage = toUsage(initial);
  return usage;
}

export function convertToolContentToText(content: Array<TextContent | { type: 'image'; mimeType: string; data: string }>): string {
  if (!Array.isArray(content) || content.length === 0) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text);
      continue;
    }
    parts.push(`[image:${block.mimeType}]`);
  }
  return parts.join('\n').trim();
}

export function isToolArgumentsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function decodeAttachmentAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function parseAttachmentAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(/\s([a-zA-Z][\w:-]*)="([^"]*)"/g)) {
    attrs[match[1]!] = decodeAttachmentAttribute(match[2] ?? '');
  }
  return attrs;
}

export function convertPersistedAttachmentPromptToBlocks(text: string): string | ContentBlock[] {
  const generatedImageMatch = /^<generated-image\b([^>]*)>$/i.exec(text.trim());
  if (generatedImageMatch) {
    const attrs = parseAttachmentAttributes(generatedImageMatch[1] ?? '');
    const generatedMime = attrs.mime ?? '';
    if (attrs.id && isSafeId(attrs.id) && /^image\/(png|jpeg|webp|gif)$/i.test(generatedMime)) {
      return [{
        type: 'file',
        fileName: attrs.name || 'generated.png',
        mimeType: generatedMime,
        status: 'ready',
        attachmentId: attrs.id,
        generated: true,
      }];
    }
  }

  const filePattern = /<file\b([^>]*)>\n?([\s\S]*?)\n?<\/file>/gi;
  const blocks: ContentBlock[] = [];
  let lastIndex = 0;
  let found = false;

  for (const match of text.matchAll(filePattern)) {
    found = true;
    const index = match.index ?? 0;
    const before = text.slice(lastIndex, index).trim();
    if (before.length > 0) {
      blocks.push({ type: 'text', text: before });
    }

    const attrs = parseAttachmentAttributes(match[1] ?? '');
    const size = Number(attrs.size);
    const body = match[2] ?? '';
    const attachmentId = attrs.id && isSafeId(attrs.id) ? attrs.id : undefined;
    blocks.push({
      type: 'file',
      fileName: attrs.name || 'attachment',
      mimeType: attrs.mime || 'application/octet-stream',
      ...(Number.isFinite(size) && size >= 0 ? { size } : {}),
      status: 'ready',
      truncated: body.includes('[Attachment truncated:'),
      ...(attachmentId ? { attachmentId } : {}),
    });
    lastIndex = index + match[0].length;
  }

  if (!found) return text;

  const after = text.slice(lastIndex).trim();
  if (after.length > 0) {
    blocks.push({ type: 'text', text: after });
  }
  return blocks;
}

export function convertPiMessageToUiBlocks(message: Message): string | ContentBlock[] {
  if (message.role === 'assistant') {
    const blocks: ContentBlock[] = [];
    for (const block of message.content) {
      if (!block) continue;
      if (block.type === 'text') {
        const converted = convertPersistedAttachmentPromptToBlocks(block.text);
        if (Array.isArray(converted)) {
          blocks.push(...converted);
        } else {
          blocks.push({ type: 'text', text: converted });
        }
        continue;
      }
      if (block.type === 'thinking') {
        blocks.push({ type: 'thinking', thinking: block.thinking });
        continue;
      }
      if (block.type === 'toolCall') {
        blocks.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: (block.arguments ?? {}) as Record<string, unknown>,
        });
      }
    }
    return blocks;
  }

  if (message.role === 'user') {
    if (typeof message.content === 'string') {
      return convertPersistedAttachmentPromptToBlocks(message.content);
    }
    const blocks: ContentBlock[] = [];
    for (const block of message.content) {
      if (block.type === 'image') {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: (block as ImageContent).mimeType, data: (block as ImageContent).data },
        });
        continue;
      }
      if (block.type === 'text') {
        const converted = convertPersistedAttachmentPromptToBlocks(block.text);
        if (Array.isArray(converted)) {
          blocks.push(...converted);
        } else if (converted.trim().length > 0) {
          blocks.push({ type: 'text', text: converted });
        }
      }
    }
    return blocks.length > 0 ? blocks : '';
  }

  const toolResult = message as ToolResultMessage;
  return [{
    type: 'tool_result',
    tool_use_id: toolResult.toolCallId,
    content: convertToolContentToText(toolResult.content),
    is_error: toolResult.isError,
    details:
      toolResult.details && typeof toolResult.details === 'object'
        ? (toolResult.details as Record<string, unknown>)
        : undefined,
  }];
}

export function convertPiMessagesToUi(messages: Message[]): AiChatMessage[] {
  const converted: AiChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      converted.push({
        role: 'user',
        content: convertPiMessageToUiBlocks(message),
        createdAt: normalizeTokenCount(message.timestamp),
      });
      continue;
    }

    if (message.role === 'assistant') {
      converted.push(
        convertAssistantMessageForUi(
          message as AssistantMessage & { meta?: AiMessageMeta },
        ),
      );
      continue;
    }

    if (message.role === 'toolResult') {
      const toolResultBlocks = convertPiMessageToUiBlocks(message);
      const last = converted[converted.length - 1];
      const toolBlocks = Array.isArray(toolResultBlocks)
        ? toolResultBlocks.filter((entry): entry is ToolResultBlock => entry.type === 'tool_result')
        : [];
      if (
        last
        && last.role === 'user'
        && Array.isArray(last.content)
        && last.content.every((entry) => entry.type === 'tool_result')
        && toolBlocks.length > 0
      ) {
        last.content.push(...toolBlocks);
      } else {
        converted.push({
          role: 'user',
          content: toolBlocks,
          createdAt: normalizeTokenCount(message.timestamp),
        });
      }
    }
  }
  return converted;
}

export function deriveUsage(messages: AiChatMessage[]): AiUsageTotals {
  let usage: AiUsageTotals = { inputTokens: 0, outputTokens: 0 };
  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    usage = mergeUsage(usage, {
      inputTokens: normalizeTokenCount(message.meta?.inputTokens),
      outputTokens: normalizeTokenCount(message.meta?.outputTokens),
    });
  }
  return usage;
}

export function deriveCost(messages: AiChatMessage[]): number {
  return messages.reduce((sum, message) => {
    if (message.role !== 'assistant') {
      return sum;
    }
    const value = Number(message.meta?.estimatedCostUsd);
    if (!Number.isFinite(value) || value <= 0) {
      return sum;
    }
    return sum + value;
  }, 0);
}

export function deriveTitle(messages: AiChatMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }
    const text = typeof message.content === 'string'
      ? message.content
      : message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      return trimmed.slice(0, 60) + (trimmed.length > 60 ? '...' : '');
    }
  }
  return 'New conversation';
}

export function convertUserMessageForUi(message: Message): AiChatMessage {
  return {
    role: 'user',
    content: convertPiMessageToUiBlocks(message),
    createdAt: normalizeTokenCount((message as { timestamp?: number }).timestamp),
  };
}

export function convertAssistantMessageForUi(
  message: AssistantMessage & { meta?: AiMessageMeta },
): AiChatMessage {
  const usage = ensureUsageShape(message.usage);
  const totalTokens = usage.totalTokens > 0 ? usage.totalTokens : usage.input + usage.output;
  const usageMeta: AiMessageMeta = {
    provider: message.provider,
    service: message.model,
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens,
    tokenSource: usage.input > 0 || usage.output > 0 ? 'usage' : 'unknown',
  };
  const content = convertPiMessageToUiBlocks(message);
  const generatedImageCount = Array.isArray(content)
    ? content.filter((block) => block.type === 'file' && block.generated).length
    : 0;
  const mergedMeta: AiMessageMeta = {
    ...usageMeta,
    ...(generatedImageCount > 0 ? { outputImages: generatedImageCount } : {}),
    ...(message.meta ?? {}),
  };
  return {
    role: 'assistant',
    content,
    createdAt: normalizeTokenCount(message.timestamp),
    meta: mergedMeta,
  };
}

export function mergeAssistantMessagesForUi(base: AiChatMessage | null, next: AiChatMessage): AiChatMessage {
  const toBlocks = (content: AiChatMessage['content']): ContentBlock[] => {
    if (Array.isArray(content)) {
      return content.map((block) => ({ ...block }));
    }
    const text = String(content ?? '');
    return text.length > 0 ? [{ type: 'text', text }] : [];
  };

  if (!base) {
    return next;
  }
  const baseContent = toBlocks(base.content);
  const nextContent = toBlocks(next.content);
  return {
    ...base,
    ...next,
    createdAt: base.createdAt || next.createdAt,
    meta: {
      ...(base.meta ?? {}),
      ...(next.meta ?? {}),
    },
    content: [...baseContent, ...nextContent],
  };
}

export function extractToolCallFromPartial(
  partial: AssistantMessage,
  contentIndex: number,
): { id: string; name: string; arguments: Record<string, unknown> } {
  const block = partial.content[contentIndex];
  if (!block || block.type !== 'toolCall') {
    return {
      id: `tool-${String(contentIndex)}`,
      name: 'tool',
      arguments: {},
    };
  }
  return {
    id: block.id || `tool-${String(contentIndex)}`,
    name: block.name || 'tool',
    arguments: (block.arguments ?? {}) as Record<string, unknown>,
  };
}

export function toToolOutputString(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return '';
  }
  const result = value as { content?: Array<{ type?: string; text?: string; mimeType?: string }> };
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(String(block.text ?? ''));
    } else {
      parts.push(`[image:${String(block.mimeType ?? 'unknown')}]`);
    }
  }
  return parts.join('\n').trim();
}

export function parseAssistantMetaFromSessionEvent(
  assistant: AssistantMessage,
  proxyMeta: AiMessageMeta | undefined,
): AiMessageMeta {
  const usage = ensureUsageShape(assistant.usage);
  const totalTokens = usage.totalTokens > 0 ? usage.totalTokens : usage.input + usage.output;
  const usageMeta: AiMessageMeta = {
    provider: assistant.provider,
    service: assistant.model,
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens,
    tokenSource: usage.input > 0 || usage.output > 0 ? 'usage' : 'unknown',
    estimatedCostUsd: usage.cost.total > 0 ? usage.cost.total : undefined,
  };
  const merged: AiMessageMeta = {
    ...usageMeta,
    ...(proxyMeta ?? {}),
  };
  if (!merged.tokenSource || merged.tokenSource === 'unknown') {
    merged.tokenSource = usageMeta.tokenSource;
  }
  if (!merged.totalTokens || merged.totalTokens <= 0) {
    merged.totalTokens = totalTokens;
  }
  if (!merged.inputTokens || merged.inputTokens <= 0) {
    merged.inputTokens = usage.input;
  }
  if (!merged.outputTokens || merged.outputTokens <= 0) {
    merged.outputTokens = usage.output;
  }
  return merged;
}
