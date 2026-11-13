import { Fragment, useMemo, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Lexer } from 'marked';
import { isToolResultOnlyMessage as isToolResultOnlyMessageShared } from './chat-shared';
import {
  segmentSensitiveChatText,
} from './chat-safety';
import type { SensitiveChatArtifact } from './chat-safety';
import { ChatCopyButton } from './ChatCopyButton';

type MarkdownContentProps = {
  text: string;
  className?: string;
  highlightQuery?: string;
  activeHighlight?: boolean;
  blockUnsafePaymentInstructions?: boolean;
};

type MarkdownToken = {
  type: string;
  raw?: string;
  text?: string;
  lang?: string;
  tokens?: MarkdownToken[];
  items?: MarkdownToken[];
  ordered?: boolean;
  depth?: number;
  href?: string;
  title?: string | null;
  header?: MarkdownToken[];
  rows?: MarkdownToken[][];
  align?: Array<'center' | 'left' | 'right' | null>;
  escaped?: boolean;
  task?: boolean;
  checked?: boolean;
};

export const isToolResultOnlyMessage = isToolResultOnlyMessageShared;

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function isSearchWordChar(char: string | undefined): boolean {
  return Boolean(char && /[\p{L}\p{N}_]/u.test(char));
}

export function findSearchPhraseMatches(text: string, query: string | undefined): Array<{ start: number; end: number }> {
  const trimmedQuery = query?.trim();
  if (!trimmedQuery) return [];

  const lowerText = text.toLowerCase();
  const lowerQuery = trimmedQuery.toLowerCase();
  const matches: Array<{ start: number; end: number }> = [];
  let cursor = 0;

  while (cursor < text.length) {
    const start = lowerText.indexOf(lowerQuery, cursor);
    if (start === -1) break;
    const end = start + trimmedQuery.length;
    const startsInsideWord = isSearchWordChar(text[start - 1]) && isSearchWordChar(text[start]);
    const endsInsideWord = isSearchWordChar(text[end - 1]) && isSearchWordChar(text[end]);

    if (!startsInsideWord && !endsInsideWord) {
      matches.push({ start, end });
    }

    cursor = end;
  }

  return matches;
}

export function hasSearchPhraseMatch(text: string, query: string | undefined): boolean {
  return findSearchPhraseMatches(text, query).length > 0;
}

function splitHighlightedText(text: string, query: string | undefined, keyPrefix: string, activeHighlight = false): ReactNode {
  const trimmedQuery = query?.trim();
  if (!trimmedQuery) return text;

  const matches = findSearchPhraseMatches(text, trimmedQuery);
  if (matches.length === 0) return text;

  const parts: ReactNode[] = [];
  let cursor = 0;

  matches.forEach((match, matchIndex) => {
    if (match.start > cursor) parts.push(text.slice(cursor, match.start));
    parts.push(
      <mark
        key={`${keyPrefix}-mark-${matchIndex}`}
        className={`chat-search-mark${activeHighlight ? ' chat-search-mark-active' : ''}`}
      >
        {text.slice(match.start, match.end)}
      </mark>,
    );
    cursor = match.end;
  });

  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function isSafeHref(rawHref: string): boolean {
  const trimmed = rawHref.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed, 'https://antseed.invalid');
    const protocol = parsed.protocol.toLowerCase();
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}

function HiddenWalletAddress({ artifact }: { artifact: SensitiveChatArtifact }) {
  const [revealed, setRevealed] = useState(false);
  const value = artifact.value;

  const handleReveal = (): void => {
    setRevealed(true);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    handleReveal();
  };

  if (!revealed) {
    return (
      <span
        className="chat-wallet-redaction"
        title="Address hidden to keep your funds secure. Click to reveal."
        role="button"
        tabIndex={0}
        onClick={handleReveal}
        onKeyDown={handleKeyDown}
      >
        [address hidden]
      </span>
    );
  }

  return <code className="chat-wallet-revealed-text">{value}</code>;
}


function SafeArtifact({ artifact }: { artifact: SensitiveChatArtifact }) {
  return <HiddenWalletAddress artifact={artifact} />;
}

function splitSafeHighlightedText(text: string, query: string | undefined, keyPrefix: string, activeHighlight = false): ReactNode {
  const segments = segmentSensitiveChatText(text);
  if (segments.length === 1 && segments[0]?.type === 'text') {
    return splitHighlightedText(segments[0].text, query, keyPrefix, activeHighlight);
  }

  return (
    <>
      {segments.map((segment, index) => {
        const key = `${keyPrefix}-safe-${index}`;
        if (segment.type === 'text') {
          return <Fragment key={key}>{splitHighlightedText(segment.text, query, key, activeHighlight)}</Fragment>;
        }
        return <SafeArtifact key={key} artifact={segment.artifact} />;
      })}
    </>
  );
}

function confirmCopyIfSensitive(_text: string): boolean {
  return true;
}

function flattenPlainText(tokens: MarkdownToken[] | undefined): string {
  if (!Array.isArray(tokens) || tokens.length === 0) return '';
  let output = '';
  for (const token of tokens) {
    if (token.type === 'br') {
      output += '\n';
      continue;
    }
    if (Array.isArray(token.tokens) && token.tokens.length > 0) {
      output += flattenPlainText(token.tokens);
      continue;
    }
    output += normalizeText(token.text ?? token.raw);
  }
  return output;
}

function renderInlineTokens(tokens: MarkdownToken[] | undefined, keyPrefix: string, highlightQuery?: string, activeHighlight = false): ReactNode[] {
  if (!Array.isArray(tokens) || tokens.length === 0) return [];
  return tokens.map((token, index) => renderInlineToken(token, `${keyPrefix}-${index}`, highlightQuery, activeHighlight));
}

function renderInlineToken(token: MarkdownToken, key: string, highlightQuery?: string, activeHighlight = false): ReactNode {
  switch (token.type) {
    case 'text':
      if (Array.isArray(token.tokens) && token.tokens.length > 0) {
        return <Fragment key={key}>{renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight)}</Fragment>;
      }
      return <Fragment key={key}>{splitSafeHighlightedText(normalizeText(token.text), highlightQuery, key, activeHighlight)}</Fragment>;
    case 'escape':
      return <Fragment key={key}>{splitSafeHighlightedText(normalizeText(token.text), highlightQuery, key, activeHighlight)}</Fragment>;
    case 'strong':
      return <strong key={key}>{renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight)}</strong>;
    case 'em':
      return <em key={key}>{renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight)}</em>;
    case 'codespan': {
      const codeText = normalizeText(token.text);
      return (
        <span key={key} className="chat-inline-code-wrap">
          <code className="chat-inline-code">
            {splitSafeHighlightedText(codeText, highlightQuery, key, activeHighlight)}
          </code>
          <CopyButton text={codeText} className="chat-inline-code-copy-btn" size={12} stopClickPropagation />
        </span>
      );
    }
    case 'br':
      return <br key={key} />;
    case 'del':
      return <del key={key}>{renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight)}</del>;
    case 'link': {
      const href = normalizeText(token.href);
      const content = renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight);

      if (!isSafeHref(href)) {
        return (
          <span key={key} className="chat-inline-link-invalid">
            {content}
          </span>
        );
      }

      return (
        <a
          key={key}
          href={href}
          style={{ color: 'var(--accent-blue)', textDecoration: 'underline' }}
          target="_blank"
          rel="noopener noreferrer"
          title={token.title ?? undefined}
        >
          {content}
        </a>
      );
    }
    case 'image': {
      const href = normalizeText(token.href);
      const alt = flattenPlainText(token.tokens) || normalizeText(token.text) || 'Image';

      if (!isSafeHref(href)) {
        return (
          <span key={key} className="chat-inline-link-invalid">
            {alt}
          </span>
        );
      }

      return <img key={key} src={href} alt={alt} className="chat-inline-image" />;
    }
    default:
      if (Array.isArray(token.tokens) && token.tokens.length > 0) {
        return <Fragment key={key}>{renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight)}</Fragment>;
      }
      return <Fragment key={key}>{splitSafeHighlightedText(normalizeText(token.text ?? token.raw), highlightQuery, key, activeHighlight)}</Fragment>;
  }
}

function renderBlockTokens(tokens: MarkdownToken[], keyPrefix: string, highlightQuery?: string, activeHighlight = false): ReactNode[] {
  return tokens.map((token, index) => renderBlockToken(token, `${keyPrefix}-${index}`, highlightQuery, activeHighlight));
}

function renderTableCell(token: MarkdownToken, key: string, highlightQuery?: string, activeHighlight = false): ReactNode {
  if (Array.isArray(token.tokens) && token.tokens.length > 0) {
    return <Fragment key={key}>{renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight)}</Fragment>;
  }
  return <Fragment key={key}>{splitSafeHighlightedText(normalizeText(token.text ?? token.raw), highlightQuery, key, activeHighlight)}</Fragment>;
}

function renderListItemContent(token: MarkdownToken, key: string, highlightQuery?: string, activeHighlight = false): ReactNode {
  if (Array.isArray(token.tokens) && token.tokens.length > 0) {
    const hasBlockTokens = token.tokens.some((child) =>
      ['paragraph', 'space', 'text', 'strong', 'em', 'codespan', 'link', 'del', 'br'].includes(child.type) === false);
    if (hasBlockTokens) {
      return <>{renderBlockTokens(token.tokens, key, highlightQuery, activeHighlight)}</>;
    }
    return <>{renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight)}</>;
  }
  return splitSafeHighlightedText(normalizeText(token.text ?? token.raw), highlightQuery, key, activeHighlight);
}

function CopyButton({ text, className, size = 14, stopClickPropagation = false }: {
  text: string;
  className: string;
  size?: number;
  stopClickPropagation?: boolean;
}) {
  return (
    <ChatCopyButton
      text={text}
      className={className}
      copiedClassName={`${className}-copied`}
      iconSize={size}
      stopClickPropagation={stopClickPropagation}
      onBeforeCopy={confirmCopyIfSensitive}
    />
  );
}

function CodeBlock({ code, lang, highlightQuery, activeHighlight }: { code: string; lang?: string; highlightQuery?: string; activeHighlight?: boolean }) {
  const langLabel = normalizeText(lang).trim() || 'code';

  return (
    <div className="chat-code-container">
      <div className="chat-code-header">
        <span className="code-lang">{langLabel}</span>
        <CopyButton text={code} className="chat-code-copy-btn" />
      </div>
      <pre>
        <code>{splitSafeHighlightedText(code, highlightQuery, 'code', activeHighlight)}</code>
      </pre>
    </div>
  );
}

function renderBlockToken(token: MarkdownToken, key: string, highlightQuery?: string, activeHighlight = false): ReactNode {
  switch (token.type) {
    case 'space':
      return null;
    case 'paragraph':
      return <p key={key}>{renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight)}</p>;
    case 'text':
      if (Array.isArray(token.tokens) && token.tokens.length > 0) {
        return <p key={key}>{renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight)}</p>;
      }
      return <p key={key}>{splitSafeHighlightedText(normalizeText(token.text), highlightQuery, key, activeHighlight)}</p>;
    case 'heading': {
      const depth = Math.min(Math.max(Number(token.depth) || 1, 1), 6);
      const children = renderInlineTokens(token.tokens, key, highlightQuery, activeHighlight);
      if (depth === 1) return <h1 key={key}>{children}</h1>;
      if (depth === 2) return <h2 key={key}>{children}</h2>;
      if (depth === 3) return <h3 key={key}>{children}</h3>;
      if (depth === 4) return <h4 key={key}>{children}</h4>;
      if (depth === 5) return <h5 key={key}>{children}</h5>;
      return <h6 key={key}>{children}</h6>;
    }
    case 'code':
      return <CodeBlock key={key} code={normalizeText(token.text)} lang={token.lang} highlightQuery={highlightQuery} activeHighlight={activeHighlight} />;
    case 'blockquote': {
      const bqText = flattenPlainText(token.tokens);
      return (
        <div key={key} className="chat-blockquote-container">
          <div className="chat-blockquote-header">
            <CopyButton text={bqText} className="chat-blockquote-copy-btn" />
          </div>
          <blockquote>{renderBlockTokens(token.tokens ?? [], key, highlightQuery, activeHighlight)}</blockquote>
        </div>
      );
    }
    case 'hr':
      return <hr key={key} />;
    case 'list': {
      const ListTag = token.ordered ? 'ol' : 'ul';
      return (
        <ListTag key={key} className="chat-md-list">
          {(token.items ?? []).map((item, index) => (
            <li key={`${key}-item-${index}`} className="chat-md-li">
              {item.task ? (
                <label className="chat-task-item">
                  <input type="checkbox" checked={Boolean(item.checked)} readOnly />
                  <span>{renderListItemContent(item, `${key}-task-${index}`, highlightQuery, activeHighlight)}</span>
                </label>
              ) : (
                renderListItemContent(item, `${key}-item-content-${index}`, highlightQuery, activeHighlight)
              )}
            </li>
          ))}
        </ListTag>
      );
    }
    case 'table':
      return (
        <div key={key} className="chat-table-wrap">
          <table className="chat-md-table">
            <thead>
              <tr>
                {(token.header ?? []).map((cell, index) => (
                  <th key={`${key}-head-${index}`} align={token.align?.[index] ?? undefined}>
                    {renderTableCell(cell, `${key}-head-cell-${index}`, highlightQuery, activeHighlight)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(token.rows ?? []).map((row, rowIndex) => (
                <tr key={`${key}-row-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${key}-row-${rowIndex}-cell-${cellIndex}`} align={token.align?.[cellIndex] ?? undefined}>
                      {renderTableCell(cell, `${key}-row-${rowIndex}-cell-content-${cellIndex}`, highlightQuery, activeHighlight)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      if (Array.isArray(token.tokens) && token.tokens.length > 0) {
        return <Fragment key={key}>{renderBlockTokens(token.tokens, key, highlightQuery, activeHighlight)}</Fragment>;
      }
      return <p key={key}>{splitSafeHighlightedText(normalizeText(token.text ?? token.raw), highlightQuery, key, activeHighlight)}</p>;
  }
}

export function MarkdownContent({ text, className = 'chat-bubble-content', highlightQuery, activeHighlight }: MarkdownContentProps) {
  const tokens = useMemo(() => Lexer.lex(text, { gfm: true, breaks: true }) as MarkdownToken[], [text]);
  return <div className={className}>{renderBlockTokens(tokens, 'md', highlightQuery, activeHighlight)}</div>;
}
