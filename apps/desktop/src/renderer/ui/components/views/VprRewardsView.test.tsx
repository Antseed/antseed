import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { VprRewardsView } from './VprRewardsView';

vi.mock('../../hooks/useActions', () => ({ useActions: () => ({ refreshPaymentSummary: vi.fn() }) }));
vi.mock('../../hooks/useUiSelector', () => ({ shallowEqual: () => true, useUiSelector: () => ({ rewards: { available: true, pendingAnts: '12', currentEpoch: 24, transfersEnabled: false }, loading: false }) }));
vi.mock('../StakingButton', () => ({ StakingButton: ({ children, page = 'stake' }: { children: React.ReactNode; page?: string }) => <button data-dashboard-page={page}>{children}</button> }));
vi.mock('../vpr/VprKit', () => ({ VprPage: ({ children }: { children: React.ReactNode }) => <main>{children}</main>, VprCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, VprBadge: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));

it('opens buyer claims and staking through the shared dashboard at their respective destinations', () => {
  const html = renderToStaticMarkup(<VprRewardsView />);
  expect(html).toContain('data-dashboard-page="rewards">Claim rewards');
  expect(html).toContain('data-dashboard-page="stake">Manage staking');
});
