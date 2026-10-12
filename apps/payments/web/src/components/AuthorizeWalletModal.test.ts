import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizeWalletModal } from './AuthorizeWalletModal';
import type { ButtonProps } from './Button';
import type { PaymentConfig } from '../types';

const state = vi.hoisted(() => ({
  connected: true,
  running: false,
  disconnecting: false,
  disconnectError: null as Error | null,
  connector: { id: 'test-wallet' },
  disconnect: vi.fn(),
  reset: vi.fn(),
  buttons: [] as ButtonProps[],
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: state.connected ? '0x0000000000000000000000000000000000000001' : undefined, isConnected: state.connected, connector: state.connector }),
  useDisconnect: () => ({ disconnect: state.disconnect, isPending: state.disconnecting, error: state.disconnectError }),
}));
vi.mock('../hooks/useSetOperator', () => ({
  useSetOperator: () => ({ run: vi.fn(), running: state.running, success: false, error: null, reset: state.reset }),
}));
vi.mock('../layout/ActionModal', () => ({ ActionModal: ({ children }: { children: ReactNode }) => children }));
vi.mock('./ConnectWalletAction', () => ({ ConnectWalletAction: () => createElement('button', null, 'Connect wallet') }));
vi.mock('./Button', () => ({
  Button: (props: ButtonProps) => {
    state.buttons.push(props);
    return createElement('button', { disabled: props.disabled }, props.children);
  },
}));

const render = () => renderToStaticMarkup(createElement(AuthorizeWalletModal, {
  isOpen: true, config: {} as PaymentConfig, hasPendingAction: false, onClose: vi.fn(), onAuthorized: vi.fn(),
}));

beforeEach(() => {
  state.connected = true;
  state.running = false;
  state.disconnecting = false;
  state.disconnectError = null;
  state.buttons = [];
  vi.clearAllMocks();
});

describe('authorization wallet disconnect', () => {
  it('offers a small disconnect action for the active connector and clears authorization errors after success', () => {
    expect(render()).toContain('Connected wallet');
    const button = state.buttons.find(button => button.children === 'Disconnect')!;
    expect(button).toMatchObject({ size: 'sm', variant: 'ghost', disabled: false });
    button.onClick?.({} as Parameters<NonNullable<ButtonProps['onClick']>>[0]);
    expect(state.disconnect).toHaveBeenCalledWith({ connector: state.connector }, { onSuccess: expect.any(Function) });
    expect(state.reset).not.toHaveBeenCalled();
    state.disconnect.mock.calls[0]![1].onSuccess();
    expect(state.reset).toHaveBeenCalledOnce();
  });

  it('returns to the connect step and disables authorization after disconnection', () => {
    state.connected = false;
    const html = render();
    expect(html).toContain('Step 1 — Connect a wallet');
    expect(html).not.toContain('Disconnect');
    expect(state.buttons.find(button => button.children === 'Authorize this wallet')?.disabled).toBe(true);
  });

  it('prevents disconnection during an authorization transaction', () => {
    state.running = true;
    render();
    expect(state.buttons.find(button => button.children === 'Disconnect')?.disabled).toBe(true);
  });

  it('prevents authorization and repeated disconnection while disconnecting', () => {
    state.disconnecting = true;
    render();
    expect(state.buttons.find(button => button.children === 'Disconnecting…')?.disabled).toBe(true);
    expect(state.buttons.find(button => button.children === 'Authorize this wallet')?.disabled).toBe(true);
  });

  it('shows disconnect failures without hiding the connected wallet', () => {
    state.disconnectError = new Error('Wallet unavailable');
    const html = render();
    expect(html).toContain('Could not disconnect: Wallet unavailable');
    expect(html).toContain('Connected wallet');
  });
});
