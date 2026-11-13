import type { DataEndpoint, DataResult, DesktopBridge } from '../../types/bridge';

type RefreshHooks = {
  renderDashboardData: (payload: {
    network: DataResult;
    peers: DataResult;
    status: DataResult;
    dataSources: DataResult;
    config: DataResult;
  }) => void;
  refreshChatConversations: () => Promise<void> | void;
};

type DashboardApiOptions = {
  bridge?: DesktopBridge;
};

export function initDashboardApiModule({ bridge }: DashboardApiOptions) {
  let refreshHooks: RefreshHooks | null = null;

  function errorResult(message: string): DataResult {
    return { ok: false, data: null, error: message, status: null };
  }

  async function getDashboardData(endpoint: DataEndpoint): Promise<DataResult> {
    if (!bridge?.getData) return errorResult('Desktop bridge unavailable');
    try {
      return await bridge.getData(endpoint);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }

  async function updateDashboardConfig(config: Record<string, unknown>): Promise<DataResult> {
    if (!bridge) return errorResult('Desktop bridge unavailable');
    if (!bridge.updateConfig) return errorResult('Config update not available');
    try {
      return await bridge.updateConfig(config);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  }

  function setRefreshHooks(hooks: RefreshHooks): void {
    refreshHooks = hooks;
  }

  async function refreshDashboardData(): Promise<void> {
    if (!refreshHooks) return;

    const { renderDashboardData, refreshChatConversations } = refreshHooks;

    const [network, peers, status, dataSources, config] = await Promise.all([
      getDashboardData('network'),
      getDashboardData('peers'),
      getDashboardData('status'),
      getDashboardData('data-sources'),
      getDashboardData('config'),
    ]);

    renderDashboardData({ network, peers, status, dataSources, config });

    void refreshChatConversations();
  }

  return {
    getDashboardData,
    updateDashboardConfig,
    setRefreshHooks,
    refreshDashboardData,
  };
}
