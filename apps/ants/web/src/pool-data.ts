import type { PoolsView } from '../../src/api-types';

export const poolDataOptions = {
  isPartial: (value: PoolsView) => value.source === 'chain' && !!value.sourceError,
  isSyncing: (value: PoolsView) => !!value.walletSyncing,
  retryOnError: false,
};

export const poolDetailOptions = {
  isSyncing: (value: { walletSyncing?: boolean }) => !!value.walletSyncing,
};
