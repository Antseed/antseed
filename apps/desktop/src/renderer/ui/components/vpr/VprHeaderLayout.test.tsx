import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { createInitialUiState } from '../../../core/state';
import { getUiStateRef, initStore } from '../../../core/store';
import { ChatView } from '../views/ChatView';
import chatStyles from '../views/ChatView.module.scss';
import { VprShell } from '../VprShell';
import { VprPage } from './VprKit';

vi.mock('../../hooks/useActions', () => ({ useActions: () => ({}) }));

beforeEach(() => {
  const state = createInitialUiState();
  state.creditsTotalOwnedUsdc = '69.13';
  state.creditsBalanceKnown = true;
  initStore(state);
});

it.each([null, 'conversation-1'])('renders help and API keys inside the chat header with conversation %s', (conversation) => {
  getUiStateRef().chatActiveConversation = conversation;
  const markup = renderToStaticMarkup(<ChatView />);
  const bodyStart = markup.indexOf(`class="${chatStyles.chatContainer}"`);
  expect(bodyStart).toBeGreaterThan(0);
  const header = markup.slice(0, bodyStart);
  expect(header).toContain('aria-label="Help"');
  expect(header).toContain('aria-label="API keys"');
});

it.each(['chat', 'home'] as const)('only floats the toolbar on home, not chat (%s)', (activeView) => {
  const markup = renderToStaticMarkup(
    <VprShell activeView={activeView} onSelectView={vi.fn()} onNavigateBack={vi.fn()}>
      <div>View content</div>
    </VprShell>,
  );
  expect(markup.includes('aria-label="API keys"')).toBe(activeView === 'home');
});

it.each(['chat', 'home'] as const)('shows the balance and Add funds in the sidebar on every view (%s)', (activeView) => {
  const markup = renderToStaticMarkup(
    <VprShell activeView={activeView} onSelectView={vi.fn()} onNavigateBack={vi.fn()}>
      <div>View content</div>
    </VprShell>,
  );
  expect(markup).toContain('$69.13');
  expect(markup).toContain('Add funds');
});

it('keeps the complete long title available on hover alongside the actions', () => {
  const title = '# Files mentioned by the user: Antseed GTM Plan - Draft.pptx.pdf';
  const markup = renderToStaticMarkup(<VprPage title={title}>Content</VprPage>);
  expect(markup).toContain(`<span title="${title}">${title}</span>`);
  expect(markup).toContain('aria-label="API keys"');
});
