import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { pointsUrl } from '../../../core/constants';
import type { DiscoverRow } from '../../../core/state';
import { PointsCalculator, pointsHint, VprRewardsView } from './VprRewardsView';

vi.mock('../../hooks/useActions', () => ({ useActions: () => ({ refreshPaymentSummary: vi.fn() }) }));
vi.mock('../../hooks/useUiSelector', () => ({ shallowEqual: () => true, useUiSelector: () => ({ rewards: { available: true, pendingAnts: '12', currentEpoch: 24, transfersEnabled: false, points: { points: 1240.6, estimatedAnts: 85.2, capped: false, endsAt: null, potAnts: 251150, totalPoints: 28667, startsAt: null, busyPointsPerDay: null } }, loading: false, buyerAddress: '0xAbC0000000000000000000000000000000000001' }) }));
vi.mock('../StakingButton', () => ({ StakingButton: ({ children, page = 'stake' }: { children: React.ReactNode; page?: string }) => <button data-dashboard-page={page}>{children}</button> }));
vi.mock('../vpr/VprKit', () => ({ VprPage: ({ children }: { children: React.ReactNode }) => <main>{children}</main>, VprCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, VprBadge: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));

it('opens buyer claims and staking through the shared dashboard at their respective destinations', () => {
  const html = renderToStaticMarkup(<VprRewardsView />);
  expect(html).toContain('data-dashboard-page="rewards">Claim rewards');
  expect(html).toContain('data-dashboard-page="stake">Manage staking');
});

it('links the buyer wallet to its Antseed Points page', () => {
  const html = renderToStaticMarkup(<VprRewardsView />);
  expect(html).toContain('1,241');
  expect(html).toContain("≈ 10,869 $ANTS at today&#x27;s rate");
  expect(html).toContain('Leaderboard and how points work');
  expect(pointsUrl('0xAbC0000000000000000000000000000000000001')).toMatch(/\/me\?address=0xabc0000000000000000000000000000000000001$/);
  expect(pointsUrl(null)).toMatch(/\/me$/);
});

it('explains the points estimate, the cap, and a missing read', () => {
  expect(pointsHint(null)).toBe("Points can't be read right now.");
  const none = { estimatedAnts: null, capped: false, endsAt: null, potAnts: null, totalPoints: null, startsAt: null, busyPointsPerDay: null };
  expect(pointsHint({ ...none, points: 10, estimatedAnts: 12557.5, capped: true })).toBe("≈ 12,558 $ANTS at today's rate");
  expect(pointsHint({ ...none, points: 0 })).toBe('No points yet this week.');
  // Same projection as the calculator: 900 of 20,000 points, three days into a Thursday-to-Thursday week.
  const DAY = 86_400_000;
  const start = Date.UTC(2026, 9, 15, 9, 54);
  const week = { ...none, points: 900, potAnts: 10_000, totalPoints: 20_000, startsAt: start, endsAt: start + 7 * DAY, busyPointsPerDay: 9_000 };
  expect(pointsHint(week, start + 3 * DAY)).toMatch(/^By Thursday, about \d+ \$ANTS · likely \d+–450$/);
});

it('matches the Points site calculator: points so far plus $50 with the best paid seller, projected to the close', () => {
  const row = (peerId: string, boost: number, input: number) => ({ peerId, peerDisplayName: peerId, peerLabel: '', protocol: 'openai-chat-completions', inputUsdPerMillion: input, outputUsdPerMillion: input, boost }) as unknown as DiscoverRow;
  const DAY = 86_400_000;
  // A week from Thursday 15 Oct 09:54 UTC (a Thursday in every time zone from UTC-9 to UTC+14), three days in.
  const start = Date.UTC(2026, 9, 15, 9, 54);
  const html = renderToStaticMarkup(
    <PointsCalculator now={start + 3 * DAY} rows={[row('Busy', 2, 1), row('Gesund', 16, 1), row('Freebie', 40, 0)]}
      points={{ points: 100, estimatedAnts: 50, capped: false, endsAt: start + 7 * DAY, potAnts: 10_000, totalPoints: 20_000, startsAt: start, busyPointsPerDay: 9_000 }} />,
  );
  // $50 × 16× = +800: 900 of 20,800 points → 433 $ANTS today; 4 more days at 20,000/3 a day → about 190.
  expect(html).toContain('What would you earn?');
  expect(html).toContain('4d 0h left');
  expect(html).toContain('Gesund · 16×');
  expect(html).not.toContain('Freebie');
  expect(html).toContain('+ 100 points you have this week');
  expect(html).toContain('433 $ANTS');
  expect(html).toContain('By Thursday, about</span><b>190 $ANTS');
  expect(html).toContain('Likely');
});
