import { Children, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { VprHeaderActions } from './VprHeaderActions';

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
