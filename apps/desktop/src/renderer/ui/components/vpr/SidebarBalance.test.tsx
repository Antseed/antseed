import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it } from 'vitest';
import { createInitialUiState } from '../../../core/state';
import { initStore } from '../../../core/store';
import { SidebarBalance } from './SidebarBalance';

function loadedState() {
  const state = createInitialUiState();
  state.creditsBalanceKnown = true;
  return state;
}

const render = (credits: string) => renderToStaticMarkup(<SidebarBalance credits={credits} onAddFunds={() => {}} />);

beforeEach(() => {
  initStore(loadedState());
});

it('shows the balance and Add funds', () => {
  const markup = render('228.14');
  expect(markup).toContain('$228.14');
  expect(markup).toContain('Add funds');
});

it('flags the balance when the deposit wallet is short of the first-deposit minimum', () => {
  const state = loadedState();
  state.creditsWalletUsdc = '1';
  state.creditsTotalOwnedUsdc = '1';
  initStore(state);
  const markup = render('1');
  expect(markup).toContain('Send $0.05 more');
  expect(markup).toContain('1.00');
});

it('shows a placeholder, not $0.00, before the balance is read', () => {
  initStore(createInitialUiState());
  const markup = render('0');
  expect(markup).toContain('as-skeleton');
  expect(markup).not.toContain('0.00');
});
