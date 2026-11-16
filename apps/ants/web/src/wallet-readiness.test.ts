import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppContext, type AppValue } from './app-context';
import { ActionButton } from './components/Confirm';
import { WalletReadinessContext, walletReadiness, type WalletConnection } from './wallet-readiness';

vi.mock('./jobs', () => ({ useJobs: () => ({ running: false }) }));

const config = { browserWallet: true, readOnly: false, walletAddress: '0xabc', evmChainId: 31337, chainId: 'base-local' } as AppValue['config'];
const connected: WalletConnection = { status: 'connected', address: '0xabc', chainId: 31337, clientAddress: '0xABC', clientChainId: 31337 };

describe('browser wallet readiness', () => {
  it.each([
    [{ status: 'disconnected', address: undefined }, 'Connect wallet'],
    [{ status: 'reconnecting' }, 'Connecting wallet…'],
    [{ chainId: 8453 }, 'Switch network'],
    [{ address: '0xdef' }, 'Waiting for wallet sync…'],
    [{ clientAddress: undefined }, 'Waiting for wallet…'],
    [{ clientAddress: '0xdef' }, 'Waiting for wallet…'],
    [{ clientChainId: 8453 }, 'Waiting for wallet…'],
  ])('blocks stale server signing state for %j', (changes, label) => {
    const readiness = walletReadiness(config, { ...connected, ...changes });
    expect(readiness.reason).toBeTruthy();
    expect(readiness.label).toBe(label);
  });

  it('requires backend synchronization as well as a connected wallet', () => {
    expect(walletReadiness({ ...config, readOnly: true }, connected).reason).toBeTruthy();
    expect(walletReadiness(config, connected)).toEqual({});
    expect(walletReadiness({ ...config, browserWallet: false }, { status: 'disconnected' })).toEqual({});
  });

  it('disables transaction submission and labels the button while disconnected', () => {
    const app = { config, overview: { wallet: { eth: '1000000' } } } as AppValue;
    const readiness = { ...walletReadiness(config, { status: 'disconnected' }), assertReady: vi.fn() };
    const html = renderToStaticMarkup(createElement(AppContext.Provider, { value: app },
      createElement(WalletReadinessContext.Provider, { value: readiness },
        createElement(ActionButton, { label: 'Withdraw', path: '/api/positions/withdraw', body: { positionIds: [26] } }))));
    expect(html).toContain('disabled=""');
    expect(html).toContain('Connect wallet');
  });
});
