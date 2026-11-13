import assert from 'node:assert/strict';
import { test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppPickerPane } from './VprToolsView';

const pane = (apps: Parameters<typeof AppPickerPane>[0]['apps'], error: string | null) => renderToStaticMarkup(
  <AppPickerPane apps={apps} error={error} onRetry={() => undefined} search="" onSearch={() => undefined}
    activeName={null} onChoose={() => undefined} noneLabel="Default action" noneMeta="Built-in" />,
);

test('a failed first read of the applications shows its error and a retry, not loading', () => {
  const html = pane(null, 'Could not list applications');
  assert.match(html, /Could not list applications/);
  assert.match(html, /Try again/);
  assert.doesNotMatch(html, /Loading applications/);
});

test('the list shows loading only while no read has failed', () => {
  assert.match(pane(null, null), /Loading applications/);
});
