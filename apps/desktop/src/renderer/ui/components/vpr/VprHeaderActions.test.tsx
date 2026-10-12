import { Children, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { createInitialUiState } from '../../../core/state';
import { initStore } from '../../../core/store';
import { VprHeaderActions } from './VprHeaderActions';

function loadedState() {
  const state = createInitialUiState();
  state.creditsBalanceKnown = true;
  return state;
}

beforeEach(() => {
  initStore(loadedState());
});

it('renders accessible Help, Settings, and balance buttons in that order', () => {
  const markup = renderToStaticMarkup(<VprHeaderActions credits="228.14" />);
  expect(markup).toContain('$228.14');
  expect(markup).toContain('aria-label="Add credits, balance $228.14"');
  expect(markup).toContain('aria-label="Settings"');
  expect(markup).toContain('aria-label="Help"');
  expect(markup.match(/<button /g)).toHaveLength(3);
  expect(markup.indexOf('aria-label="Help"')).toBeLessThan(markup.indexOf('aria-label="Settings"'));
  expect(markup.indexOf('aria-label="Settings"')).toBeLessThan(markup.indexOf('aria-label="Add credits, balance $228.14"'));
});

it('preserves deposit navigation and opens the existing preferences and help routes', () => {
  const onSelectView = vi.fn();
  const actions = VprHeaderActions({ credits: '228.14', onSelectView });
  const buttons = Children.toArray(actions.props.children);
  for (const button of buttons) {
    expect(isValidElement(button)).toBe(true);
    if (isValidElement<{ onClick: () => void }>(button)) button.props.onClick();
  }
  expect(onSelectView.mock.calls).toEqual([['help'], ['preferences'], ['deposit']]);
});

it('tolerates rendering outside a navigation provider', () => {
  const actions = VprHeaderActions({ credits: '0' });
  for (const button of Children.toArray(actions.props.children)) {
    if (isValidElement<{ onClick: () => void }>(button)) {
      expect(() => button.props.onClick()).not.toThrow();
    }
  }
});

it('flags the balance when the deposit wallet is short of the first-deposit minimum', () => {
  const state = loadedState();
  state.creditsWalletUsdc = '1';
  state.creditsTotalOwnedUsdc = '1';
  initStore(state);
  const markup = renderToStaticMarkup(<VprHeaderActions credits="1" />);
  expect(markup).toContain('Send $0.05 more');
  expect(markup).toContain('$1.00');
});

it('shows a placeholder, not $0.00 or a deposit prompt, before the balance is read', () => {
  initStore(createInitialUiState());
  const markup = renderToStaticMarkup(<VprHeaderActions credits="0" />);
  expect(markup).toContain('aria-label="Add credits, loading balance"');
  expect(markup).toContain('as-skeleton');
  expect(markup).not.toContain('$0.00');
});
