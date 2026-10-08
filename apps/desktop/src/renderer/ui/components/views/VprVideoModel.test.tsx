import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInitialUiState } from '../../../core/state';
import { initStore } from '../../../core/store';
import { normalizeDiscoverRow } from '../../../modules/catalog/discover-rows';
import { projectRowsToVprModelCatalog } from '../../../modules/catalog/model-catalog';
import { setVprModelPageTarget } from '../../../modules/catalog/model-page-target';
import { filterVprModelDropdownCatalog, otherKindVprModelDropdownCatalog } from '../chat/VprModelDropdown';
import { VprModelRowList } from '../vpr/VprModelRows';
import { VprModelView } from './VprModelView';

const { action } = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock('../../hooks/useActions', () => ({ useActions: () => new Proxy({}, { get: () => action }) }));

afterEach(() => action.mockClear());

function initialize() {
  const state = createInitialUiState();
  const rows = [
    normalizeDiscoverRow({ peerId: 'text-peer', serviceId: 'gpt-test', provider: 'openai', protocol: 'openai-chat-completions', inputUsdPerMillion: 1, outputUsdPerMillion: 2 }),
    normalizeDiscoverRow({
      peerId: 'video-peer',
      serviceId: 'wan-2.5',
      serviceLabel: 'Wan 2.5',
      provider: 'venice',
      protocol: 'venice-video',
      capabilities: { video: { durationsSeconds: [10, 5], resolutions: ['720p'] } },
      minVideoUsdPerSecond: 0.1,
      maxVideoUsdPerSecond: 0.1,
    }),
  ].filter((row) => row !== null);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1]?.capabilities?.video, { durationsSeconds: [5, 10], resolutions: ['720p'] });
  state.vprRoutableRows = rows;
  state.vprModelCatalog = projectRowsToVprModelCatalog(rows);
  state.chatDiscoverRowsLoaded = true;
  initStore(state);
  return state;
}

test('video models are listed with a Video tag and a per-second price', () => {
  const state = initialize();
  const markup = renderToStaticMarkup(
    <VprModelRowList entries={state.vprModelCatalog} onSelect={action} emptyLabel="Empty" />,
  );
  assert.match(markup, /Wan 2\.5/);
  assert.match(markup, />Video</);
  assert.match(markup, /\/sec/);
});

test('video models never appear in the chat model dropdown', () => {
  const state = initialize();
  for (const kind of ['text', 'image'] as const) {
    const listed = [
      ...filterVprModelDropdownCatalog(state.vprModelCatalog, kind),
      ...otherKindVprModelDropdownCatalog(state.vprModelCatalog, kind),
    ];
    assert.equal(listed.some((entry) => entry.kind === 'video'), false);
  }
});

test('video model page disables Use in chat without a copy action', () => {
  initialize();
  setVprModelPageTarget('venice', 'wan-2.5');
  const markup = renderToStaticMarkup(<VprModelView />);
  assert.match(markup, /<button type="button" class="[^"]*" disabled="">Use in chat<\/button>/);
  assert.match(markup, /Use in chat \(unavailable for video models\)/);
  assert.doesNotMatch(markup, /Copy instructions/);
  assert.match(markup, /Video generation/);
  assert.match(markup, /Price · \/sec/);
  assert.doesNotMatch(markup, /Start chat/);
});
