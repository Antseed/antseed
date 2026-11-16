import { HugeiconsIcon } from '@hugeicons/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { AntIcon } from './AntIcon';

it('centers a smaller solid ant inside the unchanged 20px navigation circle', () => {
  const markup = renderToStaticMarkup(<HugeiconsIcon icon={AntIcon} size={24} strokeWidth={1.8} />);

  expect(markup).toContain('viewBox="0 0 24 24"');
  expect(markup.match(/<circle /g)).toHaveLength(1);
  expect(markup).toContain('cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.8"');
  expect(markup.match(/<path /g)).toHaveLength(19);
  expect(markup.match(/fill="currentColor"/g)).toHaveLength(19);
  expect(markup.match(/stroke-opacity="0"/g)).toHaveLength(19);
  expect(markup).toContain('transform="translate(6.9087333 6) scale(0.6666667)"');
});
