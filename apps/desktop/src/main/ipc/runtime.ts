/**
 * IPC surface for the local gateway runtime: process control, logs, the peer
 * network, and config.
 */
import { isAttachOnly, preserveTestbenchRouting } from '../runtime/attach-only.js';
import { ipcMain } from 'electron';
import type { LogEvent } from '../runtime/log-parser.js';
import type { ProcessManager, RuntimeProcessState } from '../runtime/process-manager.js';

/** Shape every dashboard-style handler answers with. */
export type ApiResult = {
  ok: boolean;
  data: unknown | null;
  error: string | null;
  status: number | null;
};

/**
 * The runtime state and helpers these handlers act on. Injected rather than
 * imported so the entry point stays the single owner of the process manager
 * and the log buffer.
 */
export type RuntimeIpcDeps = {
  processManager: ProcessManager;
  logBuffer: LogEvent[];
  getCombinedProcessState: () => RuntimeProcessState[];
};

const DASHBOARD_CONFIG_ALLOWED_KEYS = new Set([
  'seller',
  'buyer',
  'identity',
  'network',
  'payments',
]);

function sanitizeDashboardConfigPayload(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (DASHBOARD_CONFIG_ALLOWED_KEYS.has(key)) {
      safe[key] = value;
    }
  }
  return safe;
}
import { ensureLocalGateway, stopLocalGateway } from '../gateway/service.js';
import {
  invalidateChainClients,
} from '../payments/credits.js';
import {
  stopPaymentsPortal,
} from '../payments/portal.js';
import {
  ACTIVE_CONFIG_PATH,
} from '../runtime/active-config.js';
import {
  mergeConfig,
  readConfig,
  readNodeStatus,
} from '../runtime/config-io.js';
import {
  getNetworkSnapshot,
  refreshPeerCache,
} from '../runtime/peer-cache.js';
export function registerRuntimeIpc(deps: RuntimeIpcDeps): void {
  const {
    getCombinedProcessState,
    logBuffer,
    processManager,
  } = deps;

  const runtimeSnapshot = () => ({
    processes: getCombinedProcessState(),
    daemonState: processManager.getDaemonStateSnapshot(),
  });

  ipcMain.handle('runtime:get-state', () => ({ ...runtimeSnapshot(), logs: [...logBuffer] }));

  // Starts the local gateway (no-op with a remote one) and waits until it serves.
  ipcMain.handle('runtime:start', async () => {
    try {
      await ensureLocalGateway();
      return { ok: true, ...runtimeSnapshot() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), ...runtimeSnapshot() };
    }
  });

  ipcMain.handle('runtime:restart', async () => {
    try {
      await stopLocalGateway();
      await ensureLocalGateway();
      return { ok: true, ...runtimeSnapshot() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), ...runtimeSnapshot() };
    }
  });

  ipcMain.handle('runtime:clear-logs', async () => {
    logBuffer.length = 0;
    return { ok: true };
  });

  ipcMain.handle(
    'runtime:get-data',
    async (_event, endpoint: string) => {
      // Serve status, config, and network directly from files — no dashboard needed.
      if (endpoint === 'status') {
        try {
          const data = await readNodeStatus(ACTIVE_CONFIG_PATH);
          return { ok: true, data, error: null, status: 200 } satisfies ApiResult;
        } catch (err) {
          return { ok: false, data: null, error: err instanceof Error ? err.message : String(err), status: null } satisfies ApiResult;
        }
      }

      if (endpoint === 'config') {
        try {
          const config = await readConfig(ACTIVE_CONFIG_PATH);
          return { ok: true, data: { config }, error: null, status: 200 } satisfies ApiResult;
        } catch (err) {
          return { ok: false, data: null, error: err instanceof Error ? err.message : String(err), status: null } satisfies ApiResult;
        }
      }

      if (endpoint === 'network' || endpoint === 'peers') {
        try {
          await refreshPeerCache();
          const snapshot = getNetworkSnapshot();
          if (endpoint === 'peers') {
            return { ok: true, data: { peers: snapshot.peers, total: snapshot.peers.length, degraded: false }, error: null, status: 200 } satisfies ApiResult;
          }
        return { ok: true, data: snapshot, error: null, status: 200 } satisfies ApiResult;
        } catch (err) {
          return { ok: false, data: null, error: err instanceof Error ? err.message : String(err), status: null } satisfies ApiResult;
        }
      }

      if (endpoint === 'data-sources') {
        return { ok: true, data: { configPath: ACTIVE_CONFIG_PATH }, error: null, status: 200 } satisfies ApiResult;
      }

      // Channels/earnings are seller-only — not needed in the desktop (buyer) app.
      return {
        ok: false,
        data: null,
        error: `Endpoint "${endpoint}" is not available in the desktop app`,
        status: null,
      } satisfies ApiResult;
    },
  );

  ipcMain.handle(
    'runtime:update-config',
    async (_event, config: Record<string, unknown>): Promise<ApiResult> => {
      const existing = isAttachOnly() ? await readConfig(ACTIVE_CONFIG_PATH).catch(() => ({})) : {};
      const safeConfig = preserveTestbenchRouting(sanitizeDashboardConfigPayload(config), existing);
      if (Object.keys(safeConfig).length === 0) {
        return { ok: false, data: null, error: 'No valid config keys provided', status: null };
      }
      try {
        const merged = await mergeConfig(safeConfig, ACTIVE_CONFIG_PATH);
        await stopPaymentsPortal();
        // Drop cached clients and the RPC backoff so the next read uses the
        // new chain config instead of answers from the old chain. Only the
        // payments section names the chain; other saves (e.g. the routing
        // preferences synced at every launch) must not reset chain reads.
        if ('payments' in safeConfig) invalidateChainClients();
        return { ok: true, data: { config: merged }, error: null, status: 200 };
      } catch (err) {
        return { ok: false, data: null, error: err instanceof Error ? err.message : String(err), status: null };
      }
    },
  );
}
