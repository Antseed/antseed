import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it } from 'vitest';
import { createInitialUiState } from '../../../core/state';
import { initStore } from '../../../core/store';
import { BalanceSummaryCard } from './BalanceSummaryCard';

const values = { available: '7.84', reserved: '4.69', pending: '0', wallet: '0', totalOwned: '12.53', creditLimit: '100', deposited: '12.53' };
const sessionsLink = /<button[^>]*title="See and close your sessions in your gateway"[^>]*>(<span[^>]*>)?held in sessions(<\/span>)?<\/button>/;

beforeEach(() => {
  const state = createInitialUiState();
  state.creditsBalanceKnown = true;
  initStore(state);
});

it('links what sessions hold to the gateway\'s channels, though plenty is available (#1463)', () => {
  // $7.84 available: no funding blocker, so no "Manage in your gateway" notice; the held amount must still lead somewhere.
  const markup = renderToStaticMarkup(<BalanceSummaryCard values={values} onShowSessions={() => {}} />);
  expect(markup).toMatch(sessionsLink);
  expect(markup).toContain('$4.69');
});

it('has no link when nothing is held', () => {
  const markup = renderToStaticMarkup(<BalanceSummaryCard values={{ ...values, reserved: '0', wallet: '1' }} onShowSessions={() => {}} />);
  expect(markup).not.toMatch(sessionsLink);
  expect(markup).toContain('not deposited yet');
});
