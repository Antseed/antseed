import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it } from 'vitest';
import { createInitialUiState } from '../../../core/state';
import { initStore } from '../../../core/store';
import { compactAmount, SidebarBalance } from './SidebarBalance';

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

it('shrinks to a wallet icon and amount in the collapsed rail', () => {
  const markup = renderToStaticMarkup(<SidebarBalance credits="25.55" onAddFunds={() => {}} compact />);
  expect(markup).toContain('$25.55');
  expect(markup).toContain('aria-label="Balance $25.55 · Add funds"');
  expect(markup).not.toContain('>Add funds<');
});

it('fits large balances into the rail', () => {
  expect(compactAmount('25.55')).toBe('25.55');
  expect(compactAmount('<0.01')).toBe('<0.01');
  expect(compactAmount('228.14')).toBe('228');
  expect(compactAmount('1234.50')).toBe('1.2k');
  expect(compactAmount('25000.00')).toBe('25k');
});
