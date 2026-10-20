import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RendererUiState } from '../../../core/state';
import type { DesktopPaymentChannelSummary } from '../../../types/bridge';
import { VprCreditsView } from './VprCreditsView';

let fakeState: RendererUiState;

vi.mock('../../hooks/useUiSelector', () => ({
  shallowEqual: () => true,
  useUiSelector: (select: (state: RendererUiState) => unknown) => select(fakeState),
}));
vi.mock('../../hooks/useActions', () => ({
  useActions: () => ({ refreshCredits: vi.fn(), refreshPaymentSummary: vi.fn() }),
}));
vi.mock('../../hooks/useFundingStatus', () => ({ useFundingStatus: () => null }));
vi.mock('../vpr/VprHeaderActions', () => ({ VprHeaderActions: () => null }));
vi.mock('./BalanceSummaryCard', () => ({ BalanceSummaryCard: () => null }));
vi.mock('./FundingStatusNotice', () => ({ FundingStatusNotice: () => null }));
vi.mock('./SignerKeyDialogs', () => ({ ExportSignerKeyDialog: () => null, ImportSignerKeyDialog: () => null }));

function channel(overrides: Partial<DesktopPaymentChannelSummary>): DesktopPaymentChannelSummary {
  return {
    channelId: '0x01',
    peerId: 'peer',
    seller: '0x0000000000000000000000000000000000000001',
    sellerDisplayName: null,
    onChainStateKnown: true,
    reserveCeiling: null,
    cumulativeSigned: '0',
    onChainDeposit: '0',
    onChainSettled: '0',
    reservedAt: 0,
    updatedAt: 0,
    status: 'active',
    requestCount: 0,
    inputTokens: '0',
    outputTokens: '0',
    cooperativeCloseSupported: false,
    ...overrides,
  };
}

function settledChannel(index: number): DesktopPaymentChannelSummary {
  return channel({
    channelId: `0xsettled${index}`,
    status: 'settled',
    onChainDeposit: '1000000',
    onChainSettled: '1000000',
    cumulativeSigned: '1000000',
  });
}

function withState(activeChannels: number, creditsChannels: DesktopPaymentChannelSummary[]) {
  fakeState = {
    creditsChannels,
    creditsBuyerUsage: {
      totalRequests: 0,
      totalInputTokens: '0',
      totalOutputTokens: '0',
      totalSettlements: 0,
      uniqueSellers: 0,
      activeChannels,
      services: [],
    },
  } as unknown as RendererUiState;
}

function tileText(): string {
  return renderToStaticMarkup(<VprCreditsView />).replace(/<[^>]+>/g, '');
}

describe('Credits payment channels tile', () => {
  it('counts no channels when every local active row is settled on-chain', () => {
    withState(6, Array.from({ length: 6 }, (_, i) => settledChannel(i)));
    expect(tileText()).toContain('Payment channels 0 active');
  });

  it('counts the funded open channels Activity lists', () => {
    withState(2, [
      channel({
        channelId: '0xopen',
        status: 'active',
        onChainDeposit: '2000000',
        onChainSettled: '500000',
        cumulativeSigned: '750000',
      }),
      settledChannel(0),
    ]);
    expect(tileText()).toContain('Payment channels 1 active');
  });
});
