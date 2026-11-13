import { Children, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { VprHeaderActions } from './VprHeaderActions';

it('renders accessible Help and API keys buttons in that order', () => {
  const markup = renderToStaticMarkup(<VprHeaderActions />);
  expect(markup.match(/<button /g)).toHaveLength(2);
  expect(markup.indexOf('aria-label="Help"')).toBeLessThan(markup.indexOf('aria-label="API keys"'));
});

it('opens Help, and the Gateway page for API keys', () => {
  const onSelectView = vi.fn();
  const actions = VprHeaderActions({ onSelectView });
  for (const button of Children.toArray(actions.props.children)) {
    if (isValidElement<{ onClick: () => void }>(button)) button.props.onClick();
  }
  expect(onSelectView.mock.calls).toEqual([['help'], ['gateway']]);
});

it('tolerates rendering outside a navigation provider', () => {
  const actions = VprHeaderActions({});
  for (const button of Children.toArray(actions.props.children)) {
    if (isValidElement<{ onClick: () => void }>(button)) {
      expect(() => button.props.onClick()).not.toThrow();
    }
  }
});
