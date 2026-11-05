import { Lexer } from 'marked';
import { formatUsd } from '../../../core/format';

type LexerToken = {
  type: string;
  raw?: string;
  text?: string;
  lang?: string;
  tokens?: LexerToken[];
  items?: LexerToken[];
  ordered?: boolean;
  depth?: number;
  href?: string;
  title?: string | null;
  header?: LexerToken[];
  rows?: LexerToken[][];
  align?: Array<'center' | 'left' | 'right' | null>;
  task?: boolean;
  checked?: boolean;
};

function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed, 'https://antseed.invalid');
    const protocol = parsed.protocol.toLowerCase();
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function flatInline(tokens: LexerToken[] | undefined): string {
  if (!tokens?.length) return '';
  let out = '';
  for (const t of tokens) {
    if (t.type === 'br') { out += '<br>'; continue; }
    if (t.tokens?.length) { out += flatInline(t.tokens); continue; }
    out += String(t.text ?? t.raw ?? '');
  }
  return out;
}

function inlineHtml(tokens: LexerToken[] | undefined): string {
  if (!tokens?.length) return '';
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
        out += t.tokens?.length ? inlineHtml(t.tokens) : esc(String(t.text ?? ''));
        break;
      case 'escape':
        out += esc(String(t.text ?? ''));
        break;
      case 'strong':
        out += `<strong>${inlineHtml(t.tokens)}</strong>`;
        break;
      case 'em':
        out += `<em>${inlineHtml(t.tokens)}</em>`;
        break;
      case 'del':
        out += `<del>${inlineHtml(t.tokens)}</del>`;
        break;
      case 'codespan':
        out += `<code class="chat-inline-code">${esc(String(t.text ?? ''))}</code>`;
        break;
      case 'br':
        out += '<br>';
        break;
      case 'link': {
        const href = String(t.href ?? '');
        const inner = inlineHtml(t.tokens) || esc(href);
        if (!isSafeHref(href)) {
          out += `<span class="chat-inline-link-invalid">${inner}</span>`;
        } else {
          const titleAttr = t.title ? ` title="${esc(t.title)}"` : '';
          out += `<a href="${esc(href)}" style="color:var(--accent-blue);text-decoration:underline" target="_blank" rel="noopener noreferrer"${titleAttr}>${inner}</a>`;
        }
        break;
      }
      case 'image': {
        const href = String(t.href ?? '');
        const alt = flatInline(t.tokens) || esc(String(t.text ?? '')) || 'Image';
        if (!isSafeHref(href)) {
          out += `<span class="chat-inline-link-invalid">${alt}</span>`;
        } else {
          out += `<img src="${esc(href)}" alt="${alt}" class="chat-inline-image">`;
        }
        break;
      }
      default:
        out += t.tokens?.length ? inlineHtml(t.tokens) : esc(String(t.text ?? t.raw ?? ''));
    }
  }
  return out;
}

function listItemHtml(token: LexerToken): string {
  if (!token.tokens?.length) return esc(String(token.text ?? token.raw ?? ''));
  const hasBlock = token.tokens.some(
    (t) => !['paragraph', 'space', 'text', 'strong', 'em', 'codespan', 'link', 'del', 'br'].includes(t.type),
  );
  return hasBlock ? blocksHtml(token.tokens) : inlineHtml(token.tokens);
}

function blocksHtml(tokens: LexerToken[]): string {
  let out = '';
  for (const [, t] of tokens.entries()) {
    switch (t.type) {
      case 'space':
        break;
      case 'paragraph':
        out += `<p>${inlineHtml(t.tokens)}</p>`;
        break;
      case 'text':
        out += t.tokens?.length ? `<p>${inlineHtml(t.tokens)}</p>` : `<p>${esc(String(t.text ?? ''))}</p>`;
        break;
      case 'heading': {
        const depth = Math.min(Math.max(Number(t.depth) || 1, 1), 6);
        out += `<h${depth}>${inlineHtml(t.tokens)}</h${depth}>`;
        break;
      }
      case 'code': {
        const lang = (t.lang ?? '').trim() || 'code';
        out += `<div class="chat-code-container"><div class="chat-code-header"><span class="code-lang">${esc(lang)}</span></div><pre><code>${esc(String(t.text ?? ''))}</code></pre></div>`;
        break;
      }
      case 'blockquote':
        out += `<blockquote>${blocksHtml(t.tokens ?? [])}</blockquote>`;
        break;
      case 'hr':
        out += '<hr>';
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const items = (t.items ?? []).map((item) => {
          if (item.task) {
            const checked = item.checked ? ' checked' : '';
            return `<li class="chat-md-li"><label class="chat-task-item"><input type="checkbox"${checked} disabled>${listItemHtml(item)}</label></li>`;
          }
          return `<li class="chat-md-li">${listItemHtml(item)}</li>`;
        }).join('');
        out += `<${tag} class="chat-md-list">${items}</${tag}>`;
        break;
      }
      case 'table': {
        const headerCells = (t.header ?? []).map((cell, ci) => {
          const align = t.align?.[ci];
          const alignAttr = align ? ` align="${align}"` : '';
          const content = cell.tokens?.length ? inlineHtml(cell.tokens) : esc(String(cell.text ?? cell.raw ?? ''));
          return `<th${alignAttr}>${content}</th>`;
        }).join('');
        const bodyRows = (t.rows ?? []).map((row) => {
          const cells = row.map((cell, ci) => {
            const align = t.align?.[ci];
            const alignAttr = align ? ` align="${align}"` : '';
            const content = cell.tokens?.length ? inlineHtml(cell.tokens) : esc(String(cell.text ?? cell.raw ?? ''));
            return `<td${alignAttr}>${content}</td>`;
          }).join('');
          return `<tr>${cells}</tr>`;
        }).join('');
        out += `<div class="chat-table-wrap"><table class="chat-md-table"><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
        break;
      }
      default:
        if (t.tokens?.length) {
          out += `<p>${inlineHtml(t.tokens)}</p>`;
        } else {
          out += `<p>${esc(String(t.text ?? t.raw ?? ''))}</p>`;
        }
    }
  }
  return out;
}

export function renderMarkdownToHtml(text: string): string {
  const tokens = Lexer.lex(text, { gfm: true, breaks: true }) as LexerToken[];
  return blocksHtml(tokens);
}

export type ChatMessage = {
  role: string;
  content: unknown;
  createdAt?: number;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ContentBlock = {
  type: string;
  renderKey?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: Record<string, unknown>;
  content?: string;
  is_error?: boolean;
  source?: { type: string; media_type?: string; data?: string };
  fileName?: string;
  mimeType?: string;
  size?: number;
  /** ID under which the raw bytes live in the attachment store. When
   *  present the renderer can build an `antseed-attachment://` URL and
   *  preview the file natively. */
  attachmentId?: string;
  generated?: boolean;
  error?: string;
  truncated?: boolean;
  attachment?: unknown;
  details?: Record<string, unknown>;
  status?: 'ready' | 'running' | 'success' | 'error';
  streaming?: boolean;
};

export type AssistantMeta = {
  provider: string | null;
  service: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokenSource: 'estimated' | 'usage' | 'unknown';
  costUsd: number;
  latencyMs: number;
  outputImages: number;
};

export const THINKING_PHRASES: readonly string[] = [
  'Hodl',
  'Brrrr',
  'NGMI',
  'WAGMI',
  'To the moon',
  'Wen channel',
  'gm',
  'Stacking sats',
  'Few understand',
  'LFG',
  'Probably nothing',
  'Aping in',
  'This is the way',
  'Ser, pls wait',
  'Number go up',
  'Diamond hands',
  'p2p2pinging',
  'Foraging for tokens',
  'Pinning to the DHT',
  'Sharding the prompt',
];

const myrmecochoryPhrases = THINKING_PHRASES;

export function isImageRequestPhase(phase: string | null | undefined): boolean {
  return phase === 'Generating image' || phase === 'Editing image';
}

export function paymentLogToThinkingPhase(line: string): string | null {
  if (!line) return null;

  // Ignore no-op lines so they don't stick as the phase label.
  if (line.includes('NeedAuth stale')) return null;
  if (line.includes('NeedAuth: maxSignable')) return null;
  if (line.includes('NeedAuth responded')) return null;

  // --- Payment negotiation ---
  if (line.includes('[PaymentMux] ← recv PaymentRequired')) return 'Received 402 Payment Required';
  if (line.includes('[BuyerNegotiator] Got 402')) return 'Auto-negotiating payment';
  if (line.includes('[BuyerNegotiator] PaymentRequired')) return 'Parsing payment terms';
  if (line.includes('[BuyerPayment] authorizeSpending')) return 'Signing SpendingAuth';
  if (line.includes('[BuyerPayment] signPerRequestAuth')) return 'Signing per-request auth';
  if (line.includes('[BuyerPayment] topUpReserve sent')) return 'Reserve top-up broadcast';
  if (line.includes('[BuyerPayment] topUpReserve')) return 'Topping up reserve';
  if (line.includes('[BuyerPayment] Depositing')) return 'Depositing to escrow';
  if (line.includes('[BuyerPayment] Withdrawing')) return 'Withdrawing from escrow';
  if (line.includes('[BuyerPayment] NeedAuth: channel')) return 'Co-signing request cost';
  if (line.includes('[BuyerPayment] AuthAck confirmed')) return 'Auth confirmed by seller';
  if (line.includes('[BuyerNegotiator] Per-request SpendingAuth sent')) return 'Per-request auth sent';
  if (line.includes('[BuyerNegotiator] SpendingAuth sent to seller')) return 'Awaiting seller ack';
  if (line.includes('[BuyerNegotiator] AuthAck received')) return 'Seller acked auth';
  if (line.includes('[BuyerNegotiator] Payment negotiated')) return 'Payment ready';
  if (line.includes('[BuyerNegotiator] Reserve top-up needed')) return 'Reserve top-up needed';

  // --- Payment wire ---
  if (line.includes('[PaymentMux] → send ReserveAuth')) return 'Sending ReserveAuth';
  if (line.includes('[PaymentMux] → send AuthAck')) return 'Acking seller auth';
  if (line.includes('[PaymentMux] ← recv SpendingAuth')) return 'Received SpendingAuth';
  if (line.includes('[PaymentMux] ← recv ReserveAuth')) return 'Received ReserveAuth';
  if (line.includes('[PaymentMux] ← recv AuthAck')) return 'Received auth ack';
  if (line.includes('[PaymentMux] ← recv NeedAuth')) return 'Settling request with seller';

  // --- Cold-start connection events (only fire when a new peer dial happens) ---
  if (line.includes('[Node] Connecting to')) return 'Dialing peer';
  if (line.includes('[Node] Connection state: open')) return 'Peer connection open';

  return null;
}

export function formatChatTime(timestamp: unknown): string {
  const ts = Number(timestamp);
  if (!ts || ts <= 0) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function formatCompactNumber(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '0';
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.floor(num));
}


export function getMyrmecochoryLabel(indexBase = 0): string {
  const index = Math.abs(Math.floor(Number(indexBase) || 0)) % myrmecochoryPhrases.length;
  return myrmecochoryPhrases[index];
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function normalizeAssistantMeta(msg: ChatMessage): AssistantMeta | null {
  if (!msg || msg.role !== 'assistant' || !msg.meta || typeof msg.meta !== 'object') return null;
  const meta = msg.meta;
  const provider = typeof meta.provider === 'string' && (meta.provider as string).trim().length > 0 ? (meta.provider as string).trim() : null;
  const service = typeof meta.service === 'string' && (meta.service as string).trim().length > 0 ? (meta.service as string).trim() : null;
  const inputTokens = Math.max(0, Math.floor(Number(meta.inputTokens) || 0));
  const outputTokens = Math.max(0, Math.floor(Number(meta.outputTokens) || 0));
  const explicitTotalTokens = Math.max(0, Math.floor(Number(meta.totalTokens) || 0));
  const totalTokens = explicitTotalTokens > 0 ? explicitTotalTokens : inputTokens + outputTokens;
  const tokenSourceRaw = String(meta.tokenSource || '').trim().toLowerCase();
  const tokenSource = tokenSourceRaw === 'estimated' ? 'estimated' : tokenSourceRaw === 'usage' ? 'usage' : 'unknown';
  const costUsd = Number.isFinite(Number(meta.estimatedCostUsd)) ? Number(meta.estimatedCostUsd) : 0;
  const latencyMs = Number.isFinite(Number(meta.latencyMs)) ? Number(meta.latencyMs) : 0;
  const outputImages = Math.max(0, Math.floor(Number(meta.outputImages) || 0));
  return {
    provider,
    service,
    inputTokens,
    outputTokens,
    totalTokens,
    tokenSource,
    costUsd: costUsd > 0 ? costUsd : 0,
    latencyMs: latencyMs > 0 ? latencyMs : 0,
    outputImages,
  };
}

export function toToolDisplayName(name: unknown): string {
  const raw = String(name || 'tool').trim();
  if (!raw) return 'Tool';
  return raw.split(/[_\-\s]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

export function compactInlineText(value: unknown, maxLength = 72): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

export function extractPrimaryToolInput(name: unknown, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const rawName = String(name || '').trim().toLowerCase();
  const payload = input as Record<string, unknown>;
  const preferredKeys = rawName === 'bash' ? ['command', 'cmd', 'script', 'args']
    : rawName === 'read_file' ? ['path', 'filePath', 'file', 'target']
    : rawName === 'write_file' ? ['path', 'filePath', 'file', 'target']
    : rawName === 'list_directory' ? ['path', 'directory', 'dir']
    : rawName === 'search_files' ? ['query', 'pattern', 'path']
    : rawName === 'grep' ? ['pattern', 'query', 'path']
    : ['command', 'cmd', 'path', 'query', 'pattern', 'target', 'file'];

  for (const key of preferredKeys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) return compactInlineText(value);
    if (Array.isArray(value) && value.length > 0) {
      const rendered = compactInlineText(value.map(String).join(' '));
      if (rendered.length > 0) return rendered;
    }
    if ((typeof value === 'number' || typeof value === 'boolean') && Number.isFinite(Number(value))) {
      return String(value);
    }
  }

  for (const value of Object.values(payload)) {
    if (typeof value === 'string' && value.trim().length > 0) return compactInlineText(value);
  }
  return '';
}

export function formatToolExecutionLabel(name: unknown, input: unknown): string {
  const toolName = toToolDisplayName(name);
  const summary = extractPrimaryToolInput(name, input);
  return summary.length > 0 ? `${toolName} (${summary})` : toolName;
}

export function buildChatMetaParts(msg: ChatMessage): string[] {
  const parts: string[] = [];
  if (msg.createdAt && Number(msg.createdAt) > 0) parts.push(formatChatTime(msg.createdAt));

  const assistantMeta = normalizeAssistantMeta(msg);

  if (assistantMeta) {
    if (assistantMeta.outputImages > 0) {
      parts.push(`${assistantMeta.outputImages} ${assistantMeta.outputImages === 1 ? 'image' : 'images'}`);
    }
    if (assistantMeta.totalTokens > 0) {
      const tokenParts = [`${formatCompactNumber(assistantMeta.totalTokens)} tok`];
      if (assistantMeta.inputTokens > 0 || assistantMeta.outputTokens > 0) {
        tokenParts.push(
          `(${formatCompactNumber(assistantMeta.inputTokens)} in / ${formatCompactNumber(assistantMeta.outputTokens)} out)`,
        );
      }
      parts.push(tokenParts.join(' '));
    }
    if (assistantMeta.costUsd > 0) parts.push(`$${formatUsd(assistantMeta.costUsd)}`);
    if (assistantMeta.latencyMs > 0) parts.push(`${Math.round(assistantMeta.latencyMs)}ms`);
  }

  return parts;
}

export function isToolResultOnlyMessage(msg: ChatMessage): boolean {
  return (
    msg.role === 'user' &&
    Array.isArray(msg.content) &&
    msg.content.length > 0 &&
    (msg.content as ContentBlock[]).every((block) => block.type === 'tool_result')
  );
}

export function cloneContentBlock(block: ContentBlock): ContentBlock {
  return {
    ...block,
    input: block.input ? { ...block.input } : undefined,
    source: block.source ? { ...block.source } : undefined,
    details: block.details ? { ...block.details } : undefined,
  };
}

function cloneChatMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    meta: message.meta ? { ...message.meta } : undefined,
    content: Array.isArray(message.content)
      ? (message.content as ContentBlock[]).map(cloneContentBlock)
      : message.content,
  };
}

function asContentBlocks(content: unknown): ContentBlock[] {
  if (Array.isArray(content)) {
    return (content as ContentBlock[]).map(cloneContentBlock);
  }
  if (typeof content === 'string' && content.length > 0) {
    return [{ type: 'text', text: content }];
  }
  return [];
}

function mergeAssistantMessages(base: ChatMessage, next: ChatMessage): ChatMessage {
  const mergedBase = cloneChatMessage(base);
  const mergedNext = cloneChatMessage(next);
  return {
    ...mergedBase,
    ...mergedNext,
    createdAt: mergedBase.createdAt || mergedNext.createdAt,
    meta: {
      ...(mergedBase.meta ?? {}),
      ...(mergedNext.meta ?? {}),
    },
    content: [...asContentBlocks(mergedBase.content), ...asContentBlocks(mergedNext.content)],
  };
}

function applyToolResultBlock(target: ChatMessage, resultBlock: ContentBlock): void {
  if (!Array.isArray(target.content)) return;
  const blocks = target.content as ContentBlock[];
  const toolUseId = String(resultBlock.tool_use_id || '').trim();
  const toolBlock = [...blocks]
    .reverse()
    .find((block) => block.type === 'tool_use' && String(block.id || '').trim() === toolUseId);
  if (toolBlock) {
    toolBlock.content = String(resultBlock.content || '');
    toolBlock.is_error = Boolean(resultBlock.is_error);
    toolBlock.status = resultBlock.is_error ? 'error' : 'success';
    if (resultBlock.details) {
      toolBlock.details = { ...resultBlock.details };
    }
    return;
  }
  blocks.push({
    ...cloneContentBlock(resultBlock),
    type: 'tool_use',
    id: toolUseId || resultBlock.id,
    name: resultBlock.name || 'tool',
    status: resultBlock.is_error ? 'error' : 'success',
  });
}

export function buildDisplayMessages(messages: ChatMessage[]): ChatMessage[] {
  const display: ChatMessage[] = [];
  let pendingAssistant: ChatMessage | null = null;

  const flushPendingAssistant = (): void => {
    if (!pendingAssistant) return;
    display.push(pendingAssistant);
    pendingAssistant = null;
  };

  for (const rawMessage of messages) {
    const message = cloneChatMessage(rawMessage);

    if (isToolResultOnlyMessage(message)) {
      if (pendingAssistant && Array.isArray(message.content)) {
        for (const block of message.content as ContentBlock[]) {
          applyToolResultBlock(pendingAssistant, block);
        }
      }
      continue;
    }

    if (message.role === 'assistant') {
      if (pendingAssistant) {
        pendingAssistant = mergeAssistantMessages(pendingAssistant, message);
      } else {
        pendingAssistant = message;
      }
      continue;
    }

    flushPendingAssistant();
    display.push(message);
  }

  flushPendingAssistant();
  return display;
}
