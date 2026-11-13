import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionDialog, Confirm } from './components/Confirm';

const modal = vi.hoisted(() => ({ close: undefined as (() => void) | undefined }));
vi.mock('@antseed/ui', async original => ({
  ...await original<typeof import('@antseed/ui')>(),
  Modal: ({ children, title, onClose }: { children: ReactNode; title: string; onClose: () => void }) => {
    modal.close = onClose;
    return createElement('section', { role: 'dialog', 'aria-label': title }, createElement('h2', null, title), children);
  },
}));

beforeEach(() => { modal.close = undefined; });

describe('action dialogs', () => {
  it('opens standalone confirmations as a modal with one title and one dialog', () => {
    const html = renderToStaticMarkup(createElement(Confirm, { title: 'Claim rewards', onConfirm: vi.fn(), onCancel: vi.fn() }));
    expect(html.match(/role="dialog"/g)).toHaveLength(1);
    expect(html.match(/>Claim rewards</g)).toHaveLength(1);
    expect(html).toContain('role="region"');
  });

  it('keeps withdrawal review inside its position modal rather than nesting dialogs', () => {
    const html = renderToStaticMarkup(createElement(ActionDialog, {
      title: 'Withdraw positions', onClose: vi.fn(),
      children: createElement(Confirm, {
        title: 'Withdraw positions', hideTitle: true, danger: true, disabled: true,
        confirmLabel: 'Withdraw and burn slashed principal', onConfirm: vi.fn(), onCancel: vi.fn(),
        children: createElement('label', null, createElement('input', { type: 'checkbox' }), 'I accept burning 166.65 ANTS'),
      }),
    }));
    expect(html.match(/role="dialog"/g)).toHaveLength(1);
    expect(html.match(/>Withdraw positions</g)).toHaveLength(1);
    expect(html).not.toContain('confirm-title');
    expect(html).not.toContain('#26');
    expect(html).toContain('I accept burning 166.65 ANTS');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?Withdraw and burn slashed principal/);
  });

  it('preserves the existing embedded stake review', () => {
    const html = renderToStaticMarkup(createElement(Confirm, { title: 'Review stake', embedded: true, onConfirm: vi.fn(), onCancel: vi.fn() }));
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain('role="region"');
    expect(modal.close).toBeUndefined();
  });

  it.each([false, true])('only dismisses a standalone confirmation when not busy (busy=%s)', busy => {
    const onCancel = vi.fn();
    renderToStaticMarkup(createElement(Confirm, { title: 'Withdraw', busy, onConfirm: vi.fn(), onCancel }));
    modal.close!();
    expect(onCancel).toHaveBeenCalledTimes(busy ? 0 : 1);
  });

  it('keeps submission errors visible in the dialog', () => {
    const html = renderToStaticMarkup(createElement(Confirm, { title: 'Withdraw', error: 'Wallet rejected request', onConfirm: vi.fn(), onCancel: vi.fn() }));
    expect(html).toContain('Wallet rejected request');
    expect(html).toContain('role="dialog"');
  });
});
