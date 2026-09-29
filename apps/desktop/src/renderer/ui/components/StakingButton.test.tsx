import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { StakingButton } from './StakingButton';

it('keeps the rewards copy action enabled when claiming is disabled', () => {
  const html = renderToStaticMarkup(<StakingButton page="rewards" disabled>Claim rewards ↗</StakingButton>);
  const buttons = html.match(/<button\b[^>]*>/g)!;
  expect(buttons).toHaveLength(2);
  expect(buttons[0]).toContain('disabled=""');
  expect(buttons[1]).not.toContain('disabled');
  expect(buttons[1]).toContain('aria-label="Copy rewards link"');
  expect(html).toContain('role="status"');
});

it('labels the staking destination and supports independently disabling copy', () => {
  const html = renderToStaticMarkup(<StakingButton copyDisabled>Manage staking ↗</StakingButton>);
  const buttons = html.match(/<button\b[^>]*>/g)!;
  expect(buttons[0]).not.toContain('disabled');
  expect(buttons[1]).toContain('disabled=""');
  expect(buttons[1]).toContain('aria-label="Copy staking link"');
});
