import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JobsProvider, useJobs, actionTitle, type JobsValue } from './jobs';
import { WalletReadinessContext } from './wallet-readiness';

const mocks = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('./api', () => ({ api: { startJob: mocks.start } }));

beforeEach(() => vi.clearAllMocks());

describe('shared transaction submission guard', () => {
  it('rechecks wallet readiness at submission, even for an already-open form', async () => {
    let connected = true;
    let jobs!: JobsValue;
    function Capture() { jobs = useJobs(); return null; }
    const readiness = { assertReady: () => { if (!connected) throw new Error('Connect wallet before submitting a transaction.'); } };
    renderToStaticMarkup(createElement(WalletReadinessContext.Provider, { value: readiness },
      createElement(JobsProvider, { children: createElement(Capture) })));
    const submit = jobs.start;
    connected = false;
    await expect(submit('/api/positions/withdraw', { positionIds: [26] })).rejects.toThrow('Connect wallet');
    expect(mocks.start).not.toHaveBeenCalled();
    connected = true;
    mocks.start.mockResolvedValue({ id: 'withdraw-26', kind: 'withdraw', status: 'running', startedAt: 1, steps: [] });
    await submit('/api/positions/withdraw', { positionIds: [26] });
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(jobs.titleForJob('withdraw-26')).toBe('Withdraw · position #26');
  });

  it('labels single and bulk positions without confusing withdrawal and restaking', () => {
    expect(actionTitle('restake', { positionIds: [25, 26] })).toBe('Stake rewards · positions #25, #26');
    expect(actionTitle('max-lock', { positionId: 29 })).toBe('Max lock · position #29');
    expect(actionTitle('stake-usage', {})).toBe('Stake rewards');
  });
});
