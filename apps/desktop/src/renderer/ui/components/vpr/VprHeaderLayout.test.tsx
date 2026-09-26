import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { createInitialUiState } from '../../../core/state';
import { getUiStateRef, initStore } from '../../../core/store';
import { ChatView } from '../views/ChatView';
import chatStyles from '../views/ChatView.module.scss';
import { VprShell } from '../VprShell';
import { VprPage } from './VprKit';

vi.mock('../../hooks/useActions', () => ({ useActions: () => ({}) }));
vi.mock('../../hooks/useTeeVerification', () => ({ useTeeBackgroundVerification: () => {} }));

beforeEach(() => {
  const state = createInitialUiState();
  state.creditsTotalOwnedUsdc = '69.13';
  initStore(state);
});

it.each([null, 'conversation-1'])('renders balance and navigation inside the chat header with conversation %s', (conversation) => {
  getUiStateRef().chatActiveConversation = conversation;
  const markup = renderToStaticMarkup(<ChatView />);
  const bodyStart = markup.indexOf(`class="${chatStyles.chatContainer}"`);
  expect(bodyStart).toBeGreaterThan(0);
  const header = markup.slice(0, bodyStart);
  expect(header).toContain('aria-label="Help"');
  expect(header).toContain('aria-label="Settings"');
  expect(header).toContain('aria-label="Add credits, balance $69.13"');
});

it.each(['chat', 'home'] as const)('only floats the toolbar on home, not chat (%s)', (activeView) => {
  const markup = renderToStaticMarkup(
    <VprShell activeView={activeView} onSelectView={vi.fn()} onNavigateBack={vi.fn()}>
      <div>View content</div>
    </VprShell>,
  );
  expect(markup.includes('aria-label="Add credits, balance $69.13"')).toBe(activeView === 'home');
});

it('keeps the complete long title available on hover alongside the balance', () => {
  const title = '# Files mentioned by the user: Antseed GTM Plan - Draft.pptx.pdf';
  const markup = renderToStaticMarkup(<VprPage title={title}>Content</VprPage>);
  expect(markup).toContain(`<span title="${title}">${title}</span>`);
  expect(markup).toContain('aria-label="Add credits, balance $69.13"');
});
