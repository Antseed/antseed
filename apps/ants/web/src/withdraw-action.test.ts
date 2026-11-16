import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WithdrawPreview } from './api';
import { singlePositionPreview, WithdrawAction, WithdrawalDetails } from './components/WithdrawAction';

const mocks = vi.hoisted(() => ({ preview: vi.fn(), button: vi.fn() }));
vi.mock('./api', () => ({ api: { withdrawPreview: mocks.preview } }));
vi.mock('./jobs', () => ({ useJobs: () => ({ running: false, start: vi.fn() }) }));
vi.mock('./app-context', () => ({ useApp: () => ({ config: { readOnly: false }, overview: { wallet: { eth: '1' } } }) }));
vi.mock('./components/ui', async original => ({
  ...await original<typeof import('./components/ui')>(),
  Button: (props: { disabled?: boolean; onClick: () => void; children: ReactNode }) => {
    mocks.button(props);
    return createElement('button', { disabled: props.disabled }, props.children);
  },
}));

const preview: WithdrawPreview = {
  positions: [{ id: 29, amount: '125000000000000000000', slashBps: 5000, slashedAmount: '62500000000000000000', returnedAmount: '62500000000000000000' }],
  totalSlashed: '62500000000000000000', totalReturned: '62500000000000000000', earlyExit: true,
  pendingRewards: '0', transfersRestricted: false, simulationError: null,
};

beforeEach(() => { vi.clearAllMocks(); mocks.preview.mockResolvedValue(preview); });

describe('single-position withdrawal', () => {
  it('requests a preview for exactly the chosen position', async () => {
    renderToStaticMarkup(createElement(WithdrawAction, { positionId: 29 }));
    mocks.button.mock.calls[0]![0].onClick();
    await vi.waitFor(() => expect(mocks.preview).toHaveBeenCalledWith([29]));
  });

  it.each([0, -1, NaN, [29, 30]])('rejects invalid or multiple position input: %j', positionId => {
    const html = renderToStaticMarkup(createElement(WithdrawAction, { positionId: positionId as number }));
    expect(html).toContain('disabled=""');
    mocks.button.mock.calls[0]![0].onClick();
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it('requires the preview to contain only the requested position', () => {
    expect(singlePositionPreview(preview, 29)).toBe(preview);
    expect(() => singlePositionPreview(preview, 30)).toThrow('does not match');
    expect(() => singlePositionPreview({ ...preview, positions: [] }, 29)).toThrow('does not match');
    expect(() => singlePositionPreview({ ...preview, positions: [...preview.positions, ...preview.positions] }, 29)).toThrow('does not match');
  });

  it('shows the withdrawal costs without a numbered table or totals row', () => {
    const html = renderToStaticMarkup(createElement(WithdrawalDetails, { preview }));
    expect(html).toContain('Early-exit penalty');
    expect(html).toContain('50.00%');
    expect(html).toContain('Burned');
    expect(html).toContain('You receive');
    expect(html).toContain('62.5');
    expect(html).toContain('ANTS');
    expect(html).not.toContain('#29');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('Total');
  });
});
