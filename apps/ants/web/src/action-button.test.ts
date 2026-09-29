import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionButton, ActionDialog, type ActionButtonProps } from './components/Confirm';

const mocks = vi.hoisted(() => ({ app: vi.fn(), jobs: vi.fn(), start: vi.fn(), pushToast: vi.fn(), button: vi.fn(), close: undefined as (() => void) | undefined }));
vi.mock('./app-context', () => ({ useApp: mocks.app }));
vi.mock('./jobs', () => ({ useJobs: mocks.jobs }));
vi.mock('./components/ui', async original => ({
  ...await original<typeof import('./components/ui')>(),
  Button: (props: { onClick: () => Promise<void>; disabled?: boolean; children: ReactNode }) => {
    mocks.button(props);
    return createElement('button', { disabled: props.disabled }, props.children);
  },
}));
vi.mock('@antseed/ui', async original => ({
  ...await original<typeof import('@antseed/ui')>(),
  Modal: ({ children, onClose }: { children: ReactNode; onClose: () => void }) => {
    mocks.close = onClose;
    return createElement('section', { role: 'dialog' }, children);
  },
}));

const action: ActionButtonProps = {
  label: 'Move allocation', path: '/api/positions/move', body: { positionIds: [30], toAgentId: 86939 },
};

function renderButton(overrides: Partial<ActionButtonProps> = {}) {
  const html = renderToStaticMarkup(createElement(ActionButton, { ...action, ...overrides }));
  return { html, button: mocks.button.mock.calls[0]![0] as { onClick: () => Promise<void>; disabled: boolean } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.close = undefined;
  mocks.app.mockReturnValue({ config: { readOnly: false }, overview: { wallet: { eth: '1' } } });
  mocks.jobs.mockReturnValue({ start: mocks.start, pushToast: mocks.pushToast, running: false });
  mocks.start.mockResolvedValue({ id: 'move-job' });
});

describe('direct action submission', () => {
  it('blocks seller and position actions when the selected buyer is managed by a separate operator', async () => {
    mocks.app.mockReturnValue({ config: { readOnly: false, selectedAddress: '0xaaa', walletAddress: '0xbbb' }, overview: { wallet: { eth: '0', signingWalletEth: '1' } } });
    const { button } = renderButton();
    expect(button.disabled).toBe(true);
    await button.onClick();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it.each([
    { path: '/api/rewards/claim', body: { scope: 'buyer', buckets: ['buyer'] } },
    { path: '/api/rewards/stake-usage', body: { side: 'buyer', stakeAgentId: 42, epochs: 4 } },
  ])('allows buyer actions using the operator gas balance: $path', async request => {
    mocks.app.mockReturnValue({ config: { readOnly: false, selectedAddress: '0xaaa', walletAddress: '0xbbb' }, overview: { wallet: { eth: '0', signingWalletEth: '1' } } });
    const { button } = renderButton(request);
    expect(button.disabled).toBeFalsy();
    await button.onClick();
    expect(mocks.start).toHaveBeenCalledWith(request.path, request.body);
  });

  it('blocks a buyer action when the signing wallet has no gas even if the selected buyer does', async () => {
    mocks.app.mockReturnValue({ config: { readOnly: false, selectedAddress: '0xaaa', walletAddress: '0xbbb' }, overview: { wallet: { eth: '1', signingWalletEth: '0' } } });
    expect(renderButton({ path: '/api/rewards/claim', body: { scope: 'buyer' } }).button.disabled).toBe(true);
  });

  it('starts one move job directly without an intermediate confirmation', async () => {
    const onStarted = vi.fn();
    const { html, button } = renderButton({ onStarted });
    expect(html).not.toContain('Confirm');
    await button.onClick();
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledWith(action.path, action.body);
    expect(onStarted).toHaveBeenCalledOnce();
  });

  it('opens required form inputs rather than submitting their defaults', async () => {
    await renderButton({ children: createElement('input', { type: 'range' }) }).button.onClick();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it.each(['/api/positions/extend', '/api/rewards/claim', '/api/verification/submit'])('submits %s without a summary-only confirmation', async path => {
    const body = { positionId: 30, epochs: 40 };
    await renderButton({ path, body }).button.onClick();
    expect(mocks.start).toHaveBeenCalledWith(path, body);
  });

  it('validates the target before starting a job', async () => {
    const validate = vi.fn(() => 'Choose a target seller.');
    await renderButton({ validate }).button.onClick();
    expect(validate).toHaveBeenCalledOnce();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it.each([{ disabled: true }, { confirmDisabled: true }])('blocks disabled actions: %j', async overrides => {
    const { button } = renderButton(overrides);
    expect(button.disabled).toBe(true);
    await button.onClick();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('blocks actions while another wallet job is running', async () => {
    mocks.jobs.mockReturnValue({ start: mocks.start, running: true });
    await renderButton().button.onClick();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('prevents double submission and dismissal while starting the job', async () => {
    let finish!: () => void;
    mocks.start.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const onClose = vi.fn();
    renderToStaticMarkup(createElement(ActionDialog, { title: 'Move allocation', onClose, children: createElement(ActionButton, action) }));
    const button = mocks.button.mock.calls[0]![0] as { onClick: () => Promise<void> };
    const pending = button.onClick();
    await button.onClick();
    mocks.close!();
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    finish();
    await pending;
    mocks.close!();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not retry a failed request automatically and permits an explicit retry', async () => {
    mocks.start.mockRejectedValueOnce(new Error('Request failed'));
    const onStarted = vi.fn();
    const { button } = renderButton({ onStarted });
    await button.onClick();
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(onStarted).not.toHaveBeenCalled();
    expect(mocks.pushToast).toHaveBeenCalledWith({ tone: 'danger', title: 'Move allocation failed', body: 'Request failed', sticky: true });
    await button.onClick();
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(onStarted).toHaveBeenCalledOnce();
  });
});
