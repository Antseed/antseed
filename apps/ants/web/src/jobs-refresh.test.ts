import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobView } from '../../src/api-types';
import { JobsProvider } from './jobs';

const mocks = vi.hoisted(() => ({ invalidate: vi.fn(), callbacks: [] as Function[] }));
vi.mock('./data', () => ({ invalidateAll: mocks.invalidate }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useCallback: (callback: Function) => { mocks.callbacks.push(callback); return callback; },
}));

let ingest: (jobs: JobView[], silent: boolean) => void;
const pending: JobView = { id: 'claim', kind: 'claim', startedAt: 1, status: 'running', steps: [] };
const confirmedStep = { at: 2, label: 'Buyer rewards claimed', hash: `0x${'a'.repeat(64)}` };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callbacks = [];
  vi.stubGlobal('window', { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() });
  renderToStaticMarkup(createElement(JobsProvider, { children: null }));
  ingest = mocks.callbacks.find(callback => callback.length === 2) as typeof ingest;
});
afterEach(() => vi.unstubAllGlobals());

describe('transaction-confirmed refresh signals', () => {
  it('does not refresh while a job is waiting for the wallet or confirmation', () => {
    ingest([pending], false);
    ingest([{ ...pending, steps: [{ at: 2, label: 'Waiting for wallet' }] }], false);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('reconciles once when a transaction-backed job completes', () => {
    ingest([pending], false);
    const done: JobView = { ...pending, status: 'done', steps: [confirmedStep] };
    ingest([done], false);
    ingest([done], false);
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledWith({ confirmed: true });
  });

  it('does not animate rejected requests without a confirmed transaction', () => {
    ingest([pending], false);
    ingest([{ ...pending, status: 'failed', error: 'User rejected' }], false);
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledWith({ confirmed: false });
  });

  it('reconciles partial success if a later transaction is rejected', () => {
    ingest([pending], false);
    ingest([{ ...pending, status: 'failed', steps: [confirmedStep], error: 'User rejected next step' }], false);
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledWith({ confirmed: true });
  });

  it('does not replay a historical completed job on page load', () => {
    const done: JobView = { ...pending, status: 'done', steps: [confirmedStep] };
    ingest([done], true);
    ingest([done], false);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('does not announce old failures discovered after initial loading', () => {
    ingest([], true);
    ingest([{ ...pending, status: 'failed', error: 'Old restaking failure' }], false);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});
