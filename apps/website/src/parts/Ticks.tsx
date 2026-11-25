import type {JSX} from 'react';

const TICK_SPLIT = /(`[^`]+`)/g;

/** Authored copy marks code with `backticks`; this renders those spans as <code>. */
export function Ticks({children}: {children?: string}): JSX.Element | null {
  if (!children) return null;
  return (
    <>
      {children.split(TICK_SPLIT).map((part, i) =>
        part.length > 2 && part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part,
      )}
    </>
  );
}

/** The same for copy that also carries HTML (links): backticks become <code> in the markup string. */
export function ticksToHtml(html: string): string {
  return html.replace(/`([^`]+)`/g, '<code>$1</code>');
}
