import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Toasts } from './components/Toasts';

const mocks = vi.hoisted(() => ({ jobs: vi.fn() }));
vi.mock('./jobs', () => ({ useJobs: mocks.jobs }));
vi.mock('./components/Activity', () => ({ TxLink: ({ hash }: { hash: string }) => createElement('span', null, hash) }));

describe('transaction toasts', () => {
  it('shows confirmations and denials in the notification stack', () => {
    mocks.jobs.mockReturnValue({ dismissToast: vi.fn(), toasts: [
      { id: 1, tone: 'success', title: 'Split position complete', hash: '0xabc', sticky: false },
      { id: 2, tone: 'danger', title: 'Max lock failed', body: 'Wallet request rejected or failed. Check your wallet before retrying.', sticky: true },
    ] });
    const html = renderToStaticMarkup(createElement(Toasts));
    expect(html).toContain('class="toasts"');
    expect(html).toContain('aria-label="Transaction notifications"');
    expect(html).toContain('role="status"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Split position complete');
    expect(html).toContain('Wallet request rejected');
    expect(html).toContain('0xabc');
  });

  it('shows nothing when there are no notifications', () => {
    mocks.jobs.mockReturnValue({ dismissToast: vi.fn(), toasts: [] });
    expect(renderToStaticMarkup(createElement(Toasts))).toBe('');
  });

  it('shows approval as progress, not as a confirmed transaction', () => {
    mocks.jobs.mockReturnValue({ dismissToast: vi.fn(), toasts: [
      { id: 1, tone: 'info', title: 'Withdraw · position #26 · Awaiting wallet approval', sticky: true },
    ] });
    const html = renderToStaticMarkup(createElement(Toasts));
    expect(html).toContain('status-icon--running');
    expect(html).not.toContain('status-icon--done');
    expect(html).toContain('Awaiting wallet approval');
    expect(html).not.toContain('Open wallet');
    expect(html).not.toContain('Track submission');
  });
});
