import type {JSX} from 'react';

const TICK_SPLIT = /(`[^`]+`)/g;
/** The longest token kept on one line: it still fits the narrowest column, a 360px phone's Run Antseed first card. */
const WHOLE_MAX = 24;
const whole = (code: string) => code.length <= WHOLE_MAX;

/** Inline code; a short token is marked `data-whole` so chip styles can keep it from splitting at a hyphen or space. */
export function Code({children}: {children: string}): JSX.Element {
  return <code data-whole={whole(children) ? '' : undefined}>{children}</code>;
}

/** Authored copy marks code with `backticks`; this renders those spans as <code>. */
export function Ticks({children}: {children?: string}): JSX.Element | null {
  if (!children) return null;
  return (
    <>
      {children.split(TICK_SPLIT).map((part, i) =>
        part.length > 2 && part.startsWith('`') && part.endsWith('`') ? <Code key={i}>{part.slice(1, -1)}</Code> : part,
      )}
    </>
  );
}

/** The same for copy that also carries HTML (links): backticks become <code> in the markup string. */
export function ticksToHtml(html: string): string {
  return html.replace(/`([^`]+)`/g, (_, code: string) => (whole(code) ? `<code data-whole>${code}</code>` : `<code>${code}</code>`));
}
