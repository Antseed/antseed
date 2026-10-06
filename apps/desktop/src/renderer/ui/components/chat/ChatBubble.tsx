import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { BrowserIcon } from '@hugeicons/core-free-icons';
import type { ReactNode } from 'react';
import { MarkdownContent } from './chat-utils.js';
import { findSensitiveChatArtifacts } from './chat-safety';
import styles from './ChatBubble.module.scss';
import { AttachmentViewer, type ViewerAttachment } from './AttachmentViewer';
import { ChatCopyButton } from './ChatCopyButton';
import type { ChatMessage, ContentBlock } from './chat-shared';
import {
  buildChatMetaParts,
  formatToolExecutionLabel,
  getMyrmecochoryLabel,
  toToolDisplayName,
} from './chat-shared';

type ToolRenderItem = {
  id: string;
  label: string;
  kind: string;
  status: 'running' | 'success' | 'error';
  output: string;
  outputLineCount: number;
  diff: string;
  additions: number;
  removals: number;
  previewUrl?: string;
};

function getToolKind(name: unknown): string {
  return String(name || '').trim().toLowerCase();
}

function getToolInputString(input: unknown, keys: string[]): string {
  if (!input || typeof input !== 'object') return '';
  const payload = input as Record<string, unknown>;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

function splitContentLinesForDiff(content: string): string[] {
  if (content.length === 0) return [];
  const withoutFinalNewline = content.endsWith('\n') ? content.slice(0, -1) : content;
  return withoutFinalNewline.split('\n');
}

function buildNewFileDiff(block: ContentBlock): string {
  const kind = getToolKind(block.name);
  if (kind !== 'write' && kind !== 'write_file') return '';

  const content = getToolInputString(block.input, ['content', 'text', 'data']);
  if (content.length === 0) return '';

  const path = getToolInputString(block.input, ['path', 'filePath', 'file', 'target']) || 'new file';
  const addedLines = splitContentLinesForDiff(content).map((line) => `+${line}`);
  return [`--- /dev/null`, `+++ ${path}`, '@@', ...addedLines].join('\n');
}

function extractToolDiff(block: ContentBlock): string {
  const detailsDiff = block.details?.diff;
  if (typeof detailsDiff === 'string' && detailsDiff.trim().length > 0) {
    return detailsDiff;
  }
  const output = String(block.content || '');
  if (/^--- .*?\n\+\+\+ .*?\n@@/m.test(output)) {
    return output;
  }
  return buildNewFileDiff(block);
}

function countDiffStats(diff: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    if (line.startsWith('-')) removals += 1;
  }
  return { additions, removals };
}

const PREVIEW_TOOL_NAMES = new Set(['open_browser_preview', 'start_dev_server']);

function extractPreviewUrl(name: unknown, input: unknown, output: string): string | undefined {
  const toolName = String(name || '');
  if (!PREVIEW_TOOL_NAMES.has(toolName)) return undefined;
  const inputObj = (typeof input === 'object' && input !== null) ? input as Record<string, unknown> : {};
  const url = typeof inputObj.url === 'string' ? inputObj.url : undefined;
  if (url) return url;
  const urlMatch = output.match(/https?:\/\/\S+/);
  return urlMatch?.[0];
}

type VerbBucket = 'edit' | 'read' | 'bash' | 'search' | 'browse' | 'write' | 'other';

function bucketForKind(kind: string): VerbBucket {
  if (kind === 'edit' || kind === 'multi_edit' || kind === 'apply_patch') return 'edit';
  if (kind === 'read' || kind === 'read_file' || kind === 'ls' || kind === 'find') return 'read';
  if (kind === 'bash' || kind === 'shell' || kind === 'run' || kind === 'execute') return 'bash';
  if (kind === 'grep' || kind === 'search' || kind === 'search_files') return 'search';
  if (kind === 'web_fetch' || kind === 'open_browser_preview' || kind === 'start_dev_server') return 'browse';
  if (kind === 'write' || kind === 'write_file') return 'write';
  return 'other';
}

function summarizeToolItems(items: ToolRenderItem[]): string {
  const counts: Record<VerbBucket, number> = {
    edit: 0, read: 0, bash: 0, search: 0, browse: 0, write: 0, other: 0,
  };
  for (const item of items) counts[bucketForKind(item.kind)] += 1;

  const phrase = (n: number, singular: string, plural: string) =>
    `${n} ${n === 1 ? singular : plural}`;

  const parts: string[] = [];
  if (counts.edit > 0)   parts.push(`Edited ${phrase(counts.edit,   'file',    'files')}`);
  if (counts.write > 0)  parts.push(`Wrote ${phrase(counts.write,   'file',    'files')}`);
  if (counts.read > 0)   parts.push(`Read ${phrase(counts.read,     'file',    'files')}`);
  if (counts.search > 0) parts.push(`Ran ${phrase(counts.search,    'search',  'searches')}`);
  if (counts.bash > 0)   parts.push(`Executed ${phrase(counts.bash, 'command', 'commands')}`);
  if (counts.browse > 0) parts.push(`Opened ${phrase(counts.browse, 'page',    'pages')}`);
  if (counts.other > 0)  parts.push(`Used ${phrase(counts.other,    'tool',    'tools')}`);

  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')}, ${parts[parts.length - 1]}`;
}

function buildToolRenderItem(block: ContentBlock, index: number): ToolRenderItem {
  const output = String(block.content || '');
  const diff = extractToolDiff(block);
  const diffStats = countDiffStats(diff);
  const status = block.status === 'running' || block.status === 'error' || block.status === 'success'
    ? block.status
    : 'success';
  return {
    id: String(block.id || `tool-${index}`),
    label: formatToolExecutionLabel(block.name, block.input),
    kind: getToolKind(block.name),
    status,
    output,
    outputLineCount: output.split('\n').filter((line) => line.trim().length > 0).length,
    diff,
    additions: diffStats.additions,
    removals: diffStats.removals,
    previewUrl: extractPreviewUrl(block.name, block.input, output),
  };
}


// messagePrefix scopes the key to a specific message so that when
// buildDisplayMessages merges consecutive assistant turns, two text-0 blocks
// from different turns don't share the same React key.
function getBlockRenderKey(block: ContentBlock, index: number, messagePrefix = ''): string {
  const base = String(block.renderKey || block.id || block.tool_use_id || `${block.type}-${index}`);
  return messagePrefix ? `${messagePrefix}-${base}` : base;
}


function StreamingMarkdown({ text, highlightQuery, activeHighlight, blockUnsafePaymentInstructions = false }: { text: string; highlightQuery?: string; activeHighlight?: boolean; blockUnsafePaymentInstructions?: boolean }) {
  const [visibleText, setVisibleText] = useState(text);
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef(0);
  const visibleTextRef = useRef(text);

  useEffect(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    if (visibleTextRef.current === text) return;
    if (!text.startsWith(visibleTextRef.current)) {
      visibleTextRef.current = text;
      setVisibleText(text);
      return;
    }

    const step = (timestamp: number): void => {
      if (lastFrameAtRef.current <= 0) {
        lastFrameAtRef.current = timestamp;
      }

      const elapsedMs = Math.max(1, timestamp - lastFrameAtRef.current);
      const currentVisibleText = visibleTextRef.current;
      const remaining = text.length - currentVisibleText.length;
      if (remaining <= 0) {
        frameRef.current = null;
        lastFrameAtRef.current = 0;
        return;
      }

      const charsPerSecond = Math.min(2600, Math.max(140, Math.ceil((remaining * 1000) / 180)));
      const charBudget = Math.max(1, Math.floor((elapsedMs * charsPerSecond) / 1000));
      const nextText = text.slice(0, Math.min(text.length, currentVisibleText.length + charBudget));

      lastFrameAtRef.current = timestamp;
      visibleTextRef.current = nextText;
      setVisibleText(nextText);
      if (nextText.length < text.length) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        frameRef.current = null;
        lastFrameAtRef.current = 0;
      }
    };

    lastFrameAtRef.current = 0;
    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      lastFrameAtRef.current = 0;
    };
  }, [text]);

  return (
    <div className="chat-bubble-content streaming-cursor">
      <MarkdownContent text={visibleText} highlightQuery={highlightQuery} activeHighlight={activeHighlight} blockUnsafePaymentInstructions={blockUnsafePaymentInstructions} />
    </div>
  );
}

function ThinkingBlockView({ block, highlightQuery, activeHighlight, blockUnsafePaymentInstructions = false }: { block: ContentBlock; highlightQuery?: string; activeHighlight?: boolean; blockUnsafePaymentInstructions?: boolean }) {
  const [manualToggle, setManualToggle] = useState<boolean | null>(null);
  const isOpen = manualToggle ?? false;
  const thinkingText = String(block.thinking || '');
  const hasThinkingText = thinkingText.trim().length > 0;

  // Some providers emit a thinking_start event before any thinking_delta, and
  // some only expose redacted/empty thinking while still spending time in the
  // reasoning phase. Keep the in-progress block visible so the user sees that
  // the model is actively thinking instead of an apparently stuck/blank turn.
  if (!hasThinkingText && !block.streaming) return null;

  const previewLength = 120;
  const normalizedThinkingPreview = thinkingText.replace(/\s+/g, ' ').trim();
  const preview = hasThinkingText
    ? (normalizedThinkingPreview.length > previewLength
        ? `${normalizedThinkingPreview.slice(0, previewLength).trimEnd()}...`
        : normalizedThinkingPreview)
    : 'Thinking...';

  return (
    <div className={`thinking-block${block.streaming ? ' streaming' : ''}${isOpen ? ' open' : ''}`}>
      <button
        type="button"
        className="thinking-block-header"
        onClick={() => setManualToggle((prev) => !(prev ?? false))}
      >
        <span className="thinking-block-triangle">›</span>
        <span className="thinking-block-label">Internal Thoughts</span>
        {!isOpen && (
          <span className="thinking-block-preview">
            <MarkdownContent text={preview} className="thinking-block-preview-md" highlightQuery={highlightQuery} activeHighlight={activeHighlight} blockUnsafePaymentInstructions={blockUnsafePaymentInstructions} />
          </span>
        )}
        {block.streaming ? (
          <span className="thinking-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        ) : null}
      </button>
      <div className={`thinking-block-body-wrap${isOpen ? '' : ' collapsed'}`}>
        <div className="thinking-block-body-inner">
          <div className="thinking-block-body">
            {hasThinkingText ? (
              block.streaming
                ? <StreamingMarkdown text={thinkingText} highlightQuery={highlightQuery} activeHighlight={activeHighlight} blockUnsafePaymentInstructions={blockUnsafePaymentInstructions} />
                : <MarkdownContent text={thinkingText} className="thinking-block-markdown" highlightQuery={highlightQuery} activeHighlight={activeHighlight} blockUnsafePaymentInstructions={blockUnsafePaymentInstructions} />
            ) : (
              <div className="chat-bubble-content streaming-cursor">Thinking...</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function createCombinedDiffItem(items: ToolRenderItem[]): ToolRenderItem | null {
  const changedItems = items.filter((item) => item.diff.trim().length > 0);
  if (changedItems.length === 0) return null;

  const additions = changedItems.reduce((sum, item) => sum + item.additions, 0);
  const removals = changedItems.reduce((sum, item) => sum + item.removals, 0);
  const diff = changedItems
    .map((item) => item.diff.trimEnd())
    .filter(Boolean)
    .join('\n\n');

  return {
    id: 'combined-diff',
    label: `${changedItems.length} ${changedItems.length === 1 ? 'file' : 'files'} changed this round`,
    kind: 'edit',
    status: changedItems.some((item) => item.status === 'error') ? 'error' : 'success',
    output: '',
    outputLineCount: 0,
    diff,
    additions,
    removals,
  };
}

function DiffStatsText({ additions, removals }: { additions: number; removals: number }) {
  return (
    <>
      {additions > 0 ? <span className="diff-additions">+{additions}</span> : null}
      {additions > 0 && removals > 0 ? <span className="tool-diff-separator">/</span> : null}
      {removals > 0 ? <span className="diff-removals">-{removals}</span> : null}
      {additions <= 0 && removals <= 0 ? <span className="diff-additions">+0</span> : null}
    </>
  );
}

function DiffStatsPill({ item, compact = false }: { item: ToolRenderItem; compact?: boolean }) {
  return (
    <span className={compact ? 'tool-diff-pill compact' : 'tool-diff-pill'}>
      <DiffStatsText additions={item.additions} removals={item.removals} />
    </span>
  );
}

function DiffStatsButton({ item, onOpen, compact = false }: { item: ToolRenderItem; onOpen: () => void; compact?: boolean }) {
  return (
    <button
      type="button"
      className="tool-diff-summary"
      title="View all changes from this round"
      onClick={(event) => { event.stopPropagation(); onOpen(); }}
    >
      <DiffStatsPill item={item} compact={compact} />
    </button>
  );
}

function ToolModal({ item, onClose }: { item: ToolRenderItem; onClose: () => void }) {
  const [closing, setClosing] = useState(false);
  const closingTimerRef = useRef<number | null>(null);

  const close = (): void => {
    setClosing(true);
    closingTimerRef.current = window.setTimeout(onClose, 180);
  };

  // Clean up the close timer if the parent unmounts while the modal is open.
  useEffect(() => {
    return () => {
      if (closingTimerRef.current !== null) {
        window.clearTimeout(closingTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const outputText =
    item.output.length > 20000
      ? `${item.output.slice(0, 20000)}\n... (truncated)`
      : item.output;

  const statusLabel =
    item.status === 'running' ? 'Running' : item.status === 'error' ? 'Error' : 'Done';

  return createPortal(
    <div
      className={`${styles.toolModalBackdrop}${closing ? ` ${styles.toolModalClosing}` : ''}`}
      onClick={close}
      role="presentation"
    >
      <div
        className={styles.toolModalPanel}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={item.label}
      >
        <div className={styles.toolModalHeader}>
          <div className={styles.toolModalTitle}>
            <span className={`${styles.toolModalDot} ${styles[item.status]}`} />
            <span className={styles.toolModalName}>{item.label}</span>
            <span className={`${styles.toolModalStatusBadge} ${styles[item.status]}`}>
              {statusLabel}
            </span>
          </div>
          <button type="button" className={styles.toolModalClose} onClick={close} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className={styles.toolModalBody}>
          {item.diff.length > 0 ? (
            <div className={styles.toolModalDiff}>
              {item.diff.split('\n').map((line, index) => {
                let cls = styles.diffContext;
                if (line.startsWith('+') && !line.startsWith('+++')) cls = styles.diffAdded;
                else if (line.startsWith('-') && !line.startsWith('---')) cls = styles.diffRemoved;
                else if (line.startsWith('@@')) cls = styles.diffHunk;
                else if (line.startsWith('+++') || line.startsWith('---')) cls = styles.diffFile;
                return (
                  <div key={`${index}-${line.slice(0, 12)}`} className={`${styles.diffLine} ${cls}`}>
                    {line}
                  </div>
                );
              })}
            </div>
          ) : outputText.trim().length > 0 ? (
            <pre className={`${styles.toolModalOutput}${item.status === 'error' ? ` ${styles.toolModalOutputError}` : ''}`}>
              {outputText}
            </pre>
          ) : (
            <div className={styles.toolModalEmpty}>No output</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ToolGroupView({ blocks, onOpenPreview }: { blocks: ContentBlock[]; onOpenPreview?: (url: string) => void }) {
  const [manualToggle, setManualToggle] = useState<boolean | null>(null);
  const [modalItem, setModalItem] = useState<ToolRenderItem | null>(null);
  const wasRunningRef = useRef(false);
  const items = useMemo(
    () => blocks.map((block, index) => buildToolRenderItem(block, index)),
    [blocks],
  );

  const anyRunning = items.some((item) => item.status === 'running');
  const anyError = items.some((item) => item.status === 'error');
  const combinedDiffItem = useMemo(() => createCombinedDiffItem(items), [items]);

  // Auto-collapse when tools finish running
  if (wasRunningRef.current && !anyRunning) {
    wasRunningRef.current = false;
  }
  if (anyRunning) wasRunningRef.current = true;

  // Closed by default (unless user manually expanded)
  const isOpen = manualToggle ?? false;

  const groupStatus: 'running' | 'success' | 'error' = anyRunning ? 'running' : anyError ? 'error' : 'success';
  const summary = summarizeToolItems(items);
  const closedLabel = anyRunning ? `Running ${items.length} ${items.length === 1 ? 'tool' : 'tools'}` : summary;
  // Activity hint: while running show the active tool; otherwise list the
  // first few tool labels with a "+N more" suffix.
  const runningItem = items.find((it) => it.status === 'running');
  const activityHint = runningItem
    ? runningItem.label
    : items.slice(0, 3).map((it) => it.label).join(' • ')
        + (items.length > 3 ? ` +${items.length - 3} more` : '');
  const toggle = () => setManualToggle((prev) => !(prev ?? false));

  return (
    <>
      <div className={`tool-group${anyRunning ? ' streaming' : ''}${isOpen ? ' open' : ''} status-${groupStatus}`}>
        <div className="tool-group-summary-bar">
          <button
            type="button"
            className="tool-group-summary-btn"
            onClick={toggle}
          >
            <span className="tool-group-chevron">›</span>
            <span className="tool-group-summary-text">
              {isOpen ? `Tools (${items.length})` : closedLabel}
            </span>
            {!isOpen && activityHint ? (
              <span className="tool-group-summary-activity">{activityHint}</span>
            ) : null}
            {anyRunning ? (
              <span className="thinking-dots" aria-hidden="true">
                <span /><span /><span />
              </span>
            ) : null}
          </button>
          {combinedDiffItem ? (
            <DiffStatsButton item={combinedDiffItem} compact onOpen={() => setModalItem(combinedDiffItem)} />
          ) : null}
        </div>
        <div className={`tool-group-list-wrap${isOpen ? '' : ' collapsed'}`}>
          <div className="tool-group-list-inner">
            <div className="tool-group-list">
              {items.map((item) => {
                const hasDiff = item.diff.length > 0;
                const hasDetail = hasDiff || item.output.trim().length > 0;

                const statusNode =
                  hasDiff ? (
                    <span className={`tool-inline-status ${item.status}`}>
                      <DiffStatsText additions={item.additions} removals={item.removals} />
                    </span>
                  ) : (
                    <span className={`tool-inline-status ${item.status}`}>
                      {item.kind === 'bash' && item.outputLineCount > 0
                        ? `${item.outputLineCount} lines`
                        : item.status === 'running'
                          ? 'Running'
                          : item.status === 'error'
                            ? 'Error'
                            : 'Done'}
                    </span>
                  );

                return (
                  <div key={item.id} className="tool-inline">
                    <button
                      type="button"
                      className={`tool-inline-row${hasDetail ? ' expandable' : ''}${hasDiff ? ' has-diff' : ''}`}
                      onClick={() => hasDetail && setModalItem(item)}
                    >
                      <span className={`tool-inline-dot ${item.status}`} />
                      <span className="tool-inline-label">{item.label}</span>
                      {statusNode}
                      <span className={`tool-inline-open${hasDetail ? '' : ' hidden'}`}>↗</span>
                    </button>
                    {item.previewUrl && onOpenPreview && (
                      <button
                        type="button"
                        className="tool-preview-btn"
                        onClick={(e) => { e.stopPropagation(); onOpenPreview(item.previewUrl!); }}
                        title={`Preview ${item.previewUrl}`}
                      >
                        <HugeiconsIcon icon={BrowserIcon} size={12} strokeWidth={1.5} />
                        Preview
                      </button>
                    )}
                  </div>
                );
              })}
              {combinedDiffItem ? (
                <button
                  type="button"
                  className="tool-change-summary-row"
                  onClick={() => setModalItem(combinedDiffItem)}
                >
                  <span>View all changes from this round</span>
                  <DiffStatsPill item={combinedDiffItem} />
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      {modalItem ? (
        <ToolModal item={modalItem} onClose={() => setModalItem(null)} />
      ) : null}
    </>
  );
}

function isRenderableThinkingBlock(block: ContentBlock): boolean {
  return Boolean(block.streaming) || String(block.thinking || '').trim().length > 0;
}

function mergeThinkingBlocks(blocks: ContentBlock[], fallbackIndex = 0): ContentBlock {
  const first = blocks[0] ?? { type: 'thinking' };
  return {
    ...first,
    type: 'thinking',
    renderKey: String(first.renderKey || first.id || first.tool_use_id || `thinking-group-${fallbackIndex}`),
    thinking: blocks
      .map((block) => String(block.thinking || '').trim())
      .filter(Boolean)
      .join('\n\n'),
    streaming: blocks.some((block) => block.streaming),
  };
}

function renderAssistantBlocks(
  blocks: ContentBlock[],
  streaming = false,
  messagePrefix = '',
  onOpenPreview?: (url: string) => void,
  conversationId?: string,
  highlightQuery?: string,
  activeHighlight?: boolean,
  blockUnsafePaymentInstructions = false,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let toolGroup: ContentBlock[] = [];
  let thinkingGroup: ContentBlock[] = [];

  const flushThinkingGroup = (): void => {
    if (thinkingGroup.length === 0) return;
    const first = thinkingGroup[0];
    const index = blocks.indexOf(first);
    nodes.push(renderBlock(
      mergeThinkingBlocks(thinkingGroup, index >= 0 ? index : nodes.length),
      index >= 0 ? index : nodes.length,
      streaming,
      messagePrefix,
      conversationId,
      highlightQuery,
      activeHighlight,
      blockUnsafePaymentInstructions,
    ));
    thinkingGroup = [];
  };

  const flushToolGroup = (): void => {
    if (toolGroup.length === 0) return;
    nodes.push(
      <ToolGroupView
        key={`${messagePrefix}-tool-group-${nodes.length}-${String(toolGroup[0]?.id || toolGroup[0]?.tool_use_id || '')}`}
        blocks={toolGroup}
        onOpenPreview={onOpenPreview}
      />,
    );
    toolGroup = [];
  };

  const flushGroups = (): void => {
    flushToolGroup();
    flushThinkingGroup();
  };

  blocks.forEach((block, index) => {
    if (block.type === 'tool_use') {
      flushThinkingGroup();
      toolGroup.push(block);
      return;
    }

    if (block.type === 'thinking') {
      if (!isRenderableThinkingBlock(block)) return;
      flushToolGroup();
      thinkingGroup.push(block);
      return;
    }

    flushGroups();
    nodes.push(renderBlock(block, index, streaming, messagePrefix, conversationId, highlightQuery, activeHighlight, blockUnsafePaymentInstructions));
  });

  flushGroups();
  return nodes;
}

function FileAttachmentBlock({ block, conversationId }: { block: ContentBlock; conversationId?: string }) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const fileName = String(block.fileName || 'attachment');
  const mimeType = String(block.mimeType || 'application/octet-stream');
  const size = typeof block.size === 'number' && Number.isFinite(block.size)
    ? formatFileSize(block.size)
    : '';
  const isError = block.status === 'error' || Boolean(block.error);

  // The card is clickable whenever we can address the bytes on disk
  // (conversationId + attachmentId). The viewer itself decides whether
  // to render an inline preview (image / PDF / HTML / text) or fall
  // back to a metadata-only state with a Download button — so docx,
  // xlsx, zip, etc. are still reachable, just not previewable in-line.
  // Old messages (pre-storage) have no attachmentId and stay as plain
  // non-clickable metadata rows.
  const attachmentId = typeof block.attachmentId === 'string' && block.attachmentId.length > 0
    ? block.attachmentId
    : null;
  const canPreview = !isError && Boolean(attachmentId) && Boolean(conversationId);

  const viewer: ViewerAttachment = useMemo(() => ({
    name: fileName,
    mimeType,
    ...(typeof block.size === 'number' ? { size: block.size } : {}),
    ...(canPreview && attachmentId && conversationId
      ? {
          src: `antseed-attachment://${encodeURIComponent(conversationId)}/${encodeURIComponent(attachmentId)}`,
          downloadIpc: { conversationId, attachmentId },
        }
      : {}),
    ...(isError && block.error ? { error: String(block.error) } : {}),
  }), [fileName, mimeType, block.size, canPreview, attachmentId, conversationId, isError, block.error]);

  const className = `${styles.fileAttachment}${isError ? ` ${styles.fileAttachmentError}` : ''}${canPreview ? ` ${styles.fileAttachmentClickable}` : ''}`;
  const metaText = [mimeType, size, block.truncated ? 'truncated' : '', isError ? String(block.error || 'unsupported') : '']
    .filter(Boolean)
    .join(' · ');
  const inlineImageSrc = block.generated && canPreview && viewer.src && mimeType.startsWith('image/')
    ? viewer.src
    : null;

  if (inlineImageSrc) {
    return (
      <>
        <button
          type="button"
          className={styles.generatedImageButton}
          onClick={() => setViewerOpen(true)}
          aria-label={`Preview ${fileName}`}
        >
          <img src={inlineImageSrc} className={styles.generatedImage} alt="Generated image" />
        </button>
        {viewerOpen && <AttachmentViewer attachment={viewer} onClose={() => setViewerOpen(false)} />}
      </>
    );
  }

  const inner = (
    <>
      <div className={styles.fileAttachmentIcon} aria-hidden="true">
        {fileName.split('.').pop()?.slice(0, 3).toUpperCase() || 'FILE'}
      </div>
      <div className={styles.fileAttachmentBody}>
        <div className={styles.fileAttachmentName}>{fileName}</div>
        <div className={styles.fileAttachmentMeta}>{metaText}</div>
      </div>
    </>
  );

  return (
    <>
      {canPreview ? (
        <button
          type="button"
          className={className}
          onClick={() => setViewerOpen(true)}
          aria-label={`Preview ${fileName}`}
        >
          {inner}
        </button>
      ) : (
        <div className={className}>{inner}</div>
      )}
      {viewerOpen && (
        <AttachmentViewer attachment={viewer} onClose={() => setViewerOpen(false)} />
      )}
    </>
  );
}

function ImageBlockView({ block }: { block: ContentBlock }) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const mediaType = String(block.source?.media_type || 'image/png');
  const data = String(block.source?.data || '');
  if (!data) return null;
  const src = `data:${mediaType};base64,${data}`;
  const viewer: ViewerAttachment = {
    name: 'image',
    mimeType: mediaType,
    imageBase64: data,
    imageMimeType: mediaType,
  };
  return (
    <>
      <img
        src={src}
        className="chat-image-preview chat-image-clickable"
        alt="Attached image"
        onClick={() => setViewerOpen(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setViewerOpen(true);
          }
        }}
      />
      {viewerOpen && (
        <AttachmentViewer attachment={viewer} onClose={() => setViewerOpen(false)} />
      )}
    </>
  );
}

function renderBlock(
  block: ContentBlock,
  index: number,
  streaming = false,
  messagePrefix = '',
  conversationId?: string,
  highlightQuery?: string,
  activeHighlight?: boolean,
  blockUnsafePaymentInstructions = false,
): ReactNode {
  const blockKey = getBlockRenderKey(block, index, messagePrefix);

  if (block.type === 'text') {
    if (block.streaming) {
      return <StreamingMarkdown key={blockKey} text={String(block.text || '')} highlightQuery={highlightQuery} activeHighlight={activeHighlight} blockUnsafePaymentInstructions={blockUnsafePaymentInstructions} />;
    }
    return <MarkdownContent key={blockKey} text={String(block.text || '')} highlightQuery={highlightQuery} activeHighlight={activeHighlight} blockUnsafePaymentInstructions={blockUnsafePaymentInstructions} />;
  }

  if (block.type === 'thinking') {
    return <ThinkingBlockView key={blockKey} block={block} highlightQuery={highlightQuery} activeHighlight={activeHighlight} blockUnsafePaymentInstructions={blockUnsafePaymentInstructions} />;
  }

  if (block.type === 'file') {
    return <FileAttachmentBlock key={blockKey} block={block} conversationId={conversationId} />;
  }

  if (block.type === 'tool_use') {
    // tool_use blocks are grouped by renderAssistantBlocks into ToolGroupView
    return null;
  }

  if (block.type === 'tool_result' && block.is_error) {
    const normalizedOutput = String(block.content || '');
    const truncated =
      normalizedOutput.length > 600
        ? `${normalizedOutput.slice(0, 600)}\n... (truncated)`
        : normalizedOutput;
    return (
      <div key={blockKey} className="tool-inline">
        <div className="tool-inline-output error">{truncated}</div>
      </div>
    );
  }

  if (block.type === 'image' && block.source?.data && block.source?.media_type) {
    return <ImageBlockView key={blockKey} block={block} />;
  }

  return null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function extractPlainText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .filter((block) => block.type === 'text' || block.type === 'thinking')
      .map((block) => (block.type === 'thinking' ? String(block.thinking || '') : String(block.text || '')))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function CopyResponseButton({ content }: { content: unknown }) {
  const getText = useCallback(() => extractPlainText(content), [content]);
  const confirmCopy = useCallback((text: string) => {
    const artifacts = findSensitiveChatArtifacts(text);
    if (artifacts.length === 0) return true;
    return window.confirm(
      'This response contains hidden addresses or gated links. Antseed will never ask you to send funds, deposit, top up, connect a wallet, or approve transactions from chat. Copy the original response anyway?',
    );
  }, []);

  return (
    <ChatCopyButton
      getText={getText}
      onBeforeCopy={confirmCopy}
      className={styles.copyResponseBtn}
      copiedClassName={styles.copyResponseBtnCopied}
      iconSize={16}
      timeoutMs={2000}
      ariaLabel="Copy response"
    />
  );
}

type ChatBubbleProps = {
  message: ChatMessage;
  streaming?: boolean;
  onOpenPreview?: (url: string) => void;
  /** Identifies the surrounding conversation so file-block previews can
   *  build `antseed-attachment://<conversationId>/<attachmentId>` URLs. */
  conversationId?: string;
  searchQuery?: string;
  searchActive?: boolean;
};

export function ChatBubble({ message, streaming = false, onOpenPreview, conversationId, searchQuery, searchActive }: ChatBubbleProps) {
  const [metaExpanded, setMetaExpanded] = useState(false);
  const metaParts = useMemo(() => buildChatMetaParts(message), [message]);
  const hasStreamingBlocks = useMemo(
    () =>
      Array.isArray(message.content) &&
      (message.content as ContentBlock[]).some((block) => block.streaming),
    [message.content],
  );
  const isStreamingBubble = streaming || hasStreamingBlocks;

  // Derive a stable per-message prefix so block keys are scoped to this message
  // and don't collide when buildDisplayMessages merges consecutive assistant turns.
  const messagePrefix = String(
    (message as { id?: unknown }).id ||
    message.createdAt ||
    message.role,
  );

  const content = useMemo(() => {
    if (message.role === 'assistant') {
      if (Array.isArray(message.content)) {
        return renderAssistantBlocks(message.content as ContentBlock[], isStreamingBubble, messagePrefix, onOpenPreview, conversationId, searchQuery, searchActive, true);
      }
      return <MarkdownContent text={String(message.content)} highlightQuery={searchQuery} activeHighlight={searchActive} blockUnsafePaymentInstructions />;
    }

    if (typeof message.content === 'string') {
      return <MarkdownContent text={message.content} highlightQuery={searchQuery} activeHighlight={searchActive} />;
    }

    if (Array.isArray(message.content)) {
      return (message.content as ContentBlock[]).map((block, index) => renderBlock(block, index, isStreamingBubble, messagePrefix, conversationId, searchQuery, searchActive, false));
    }

    return <div className="chat-bubble-content">{JSON.stringify(message.content)}</div>;
  }, [message, isStreamingBubble, messagePrefix, onOpenPreview, conversationId, searchQuery, searchActive]);

  const bubbleMeta =
    metaParts.length > 0 && !isStreamingBubble ? (
      <span className={styles.chatBubbleStats}>{metaParts.join(' · ')}</span>
    ) : null;

  return (
    <div className={`${styles.chatBubble} ${message.role === 'user' ? styles.own : styles.other}`}>
      {bubbleMeta}
      <div>{content}</div>
      {message.role !== 'user' && !isStreamingBubble ? (
        <div className={styles.messageActions}>
          <CopyResponseButton content={message.content} />
        </div>
      ) : null}
    </div>
  );
}
