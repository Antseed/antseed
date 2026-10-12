/**
 * IPC surface for the buyer/connect runtime: process control, logs, the peer
 * network, plugins, and dashboard config.
 */
import { ipcMain } from 'electron';
import { stakingSessions } from '../staking/portal.js';
import { isMultiInstanceDevelopment } from '../dev-instance.js';
import type { LogEvent } from '../runtime/log-parser.js';
import type { ProcessManager, RuntimeProcessState } from '../runtime/process-manager.js';
import { resolveBuyerProxyPort } from '../runtime/active-config.js';
import { isCompatibleSharedBuyer, refreshSharedBuyerAttachment } from '../runtime/shared-buyer.js';
import { resolveConnectDataDir } from '../runtime/process-manager.js';
import { requestTeeSnapshot } from '../runtime/tee-verification.js';
import type { DesktopTeeStatus } from '@antseed/node/tee-status';

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
  appendLog: (mode: RuntimeMode, stream: 'stdout' | 'stderr' | 'system', line: string) => void;
  getCombinedProcessState: () => RuntimeProcessState[];
  killOrphanBuyerProxy: () => Promise<void>;
  requestBuyerPeerRefresh: () => Promise<void>;
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
import {
  isDesktopDebugEnabled,
} from '../app-context.js';
import {
  invalidateOnChainEnrichmentCache,
} from '../chat/service-discovery.js';
import {
  ensureSecureIdentity,
  secureIdentityEnv,
} from '../identity.js';
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
  lookupPeer,
  refreshPeerCache,
  touchPeer,
} from '../runtime/peer-cache.js';
import {
  type InstalledPlugin,
  installPluginDependency,
  isSafePluginPackageName,
  listInstalledPlugins,
  normalizePluginPackageName,
  resolveLegacyPluginPackage,
  resolveLocalPluginSource,
  toFileInstallSpec,
  toNpmAliasInstallSpec,
} from '../runtime/plugins.js';
import {
  type RuntimeMode,
  type StartOptions,
} from '../runtime/process-manager.js';

export function registerRuntimeIpc(deps: RuntimeIpcDeps): void {
  const {
    appendLog,
    getCombinedProcessState,
    killOrphanBuyerProxy,
    logBuffer,
    processManager,
    requestBuyerPeerRefresh,
  } = deps;

  let lastTeeError: string | undefined;
  const teeStatus = async (peerId?: string): Promise<DesktopTeeStatus> => {
    try {
      const snapshot = await requestTeeSnapshot(resolveConnectDataDir(), await resolveBuyerProxyPort(), peerId);
      lastTeeError = undefined;
      return { snapshot };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Verification unavailable';
      if (message !== lastTeeError) appendLog('connect', 'system', message);
      lastTeeError = message;
      return { snapshot: null, error: message };
    }
  };
  ipcMain.handle('tee:status', () => teeStatus());
  ipcMain.handle('tee:check', (_event, peerId: string) => {
    if (typeof peerId !== 'string' || !/^(?:0x)?[a-f0-9]{40}$/i.test(peerId)) throw new Error('Invalid seller peer ID');
    return teeStatus(peerId);
  });

  ipcMain.handle('runtime:get-state', async () => {
    if (isMultiInstanceDevelopment() && processManager.isAttached('connect')) {
      const port = await resolveBuyerProxyPort();
      await refreshSharedBuyerAttachment(processManager, port);
    }
    return {
      processes: getCombinedProcessState(),
      daemonState: processManager.getDaemonStateSnapshot(),
      logs: [...logBuffer],
    };
  });

  ipcMain.handle('runtime:start', async (_event, options: StartOptions) => {
    if (options.mode === 'connect' && isMultiInstanceDevelopment()) {
      const port = await resolveBuyerProxyPort();
      if (await isCompatibleSharedBuyer(port)) {
        const state = processManager.attach('connect');
        appendLog('connect', 'system', `Reusing shared buyer proxy on 127.0.0.1:${port}.`);
        return {
          state,
          processes: getCombinedProcessState(),
          daemonState: processManager.getDaemonStateSnapshot(),
        };
      }
    }

    await ensureSecureIdentity();

    const startOptions: StartOptions = {
      ...options,
      ...(isDesktopDebugEnabled() ? { verbose: true } : {}),
      env: {
        ...(options.env ?? {}),
        ...(isDesktopDebugEnabled() ? { ANTSEED_DEBUG: '1' } : {}),
        ...secureIdentityEnv(),
      },
    };
    if (isDesktopDebugEnabled()) {
      appendLog(startOptions.mode, 'system', 'Desktop debug mode enabled (ANTSEED_DEBUG=1, --verbose).');
    }

    const state = await processManager.start(startOptions);
    return {
      state,
      processes: getCombinedProcessState(),
      daemonState: processManager.getDaemonStateSnapshot(),
    };
  });

  ipcMain.handle('runtime:stop', async (_event, mode: RuntimeMode) => {
    const preserveSharedBuyer = mode === 'connect' && isMultiInstanceDevelopment();
    const state = await processManager.stop(mode, preserveSharedBuyer);
    if (mode === 'connect') {
      // Normal Stop must silence the buyer proxy, not just our child. Named
      // development instances instead release shared ownership so one test
      // window cannot break every other window and connected tool.
      if (!isMultiInstanceDevelopment()) {
        await killOrphanBuyerProxy();
      }
    }
    return {
      state,
      processes: getCombinedProcessState(),
      daemonState: processManager.getDaemonStateSnapshot(),
    };
  });

  ipcMain.handle('runtime:clear-logs', async () => {
    logBuffer.length = 0;
    return { ok: true };
  });

  ipcMain.handle('plugins:list', async () => {
    try {
      const plugins = await listInstalledPlugins();
      return { ok: true, plugins, error: null };
    } catch (err) {
      return {
        ok: false,
        plugins: [] as InstalledPlugin[],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle('plugins:install', async (_event, packageName: string) => {
    const normalized = typeof packageName === 'string' ? normalizePluginPackageName(packageName) : '';
    if (!normalized || !isSafePluginPackageName(normalized)) {
      return {
        ok: false,
        package: normalized,
        plugins: [] as InstalledPlugin[],
        error: `Invalid plugin package name: ${packageName}`,
      };
    }

    try {
      appendLog('connect', 'system', `Installing plugin "${normalized}"...`);
      await installPluginDependency(normalized);
      const plugins = await listInstalledPlugins();
      appendLog('connect', 'system', `Installed plugin "${normalized}".`);
      return { ok: true, package: normalized, plugins, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const legacyPackageName = resolveLegacyPluginPackage(normalized);

      if (legacyPackageName) {
        try {
          const aliasSpec = toNpmAliasInstallSpec(normalized, legacyPackageName);
          appendLog('connect', 'system', `Registry install failed; retrying via legacy alias: ${aliasSpec}`);
          await installPluginDependency(aliasSpec);
          const plugins = await listInstalledPlugins();
          appendLog('connect', 'system', `Installed plugin "${normalized}" using legacy package alias "${legacyPackageName}".`);
          return { ok: true, package: normalized, plugins, error: null };
        } catch (legacyErr) {
          const legacyMessage = legacyErr instanceof Error ? legacyErr.message : String(legacyErr);
          appendLog('connect', 'system', `Legacy alias install failed for "${normalized}": ${legacyMessage}`);
        }
      }

      const localSource = await resolveLocalPluginSource(normalized);

      if (localSource) {
        try {
          appendLog('connect', 'system', `Registry install failed; retrying from local source: ${localSource}`);
          await installPluginDependency(toFileInstallSpec(normalized, localSource));
          const plugins = await listInstalledPlugins();
          appendLog('connect', 'system', `Installed plugin "${normalized}" from local source.`);
          return { ok: true, package: normalized, plugins, error: null };
        } catch (localErr) {
          const localMessage = localErr instanceof Error ? localErr.message : String(localErr);
          appendLog('connect', 'system', `Local plugin install failed for "${normalized}": ${localMessage}`);
          return {
            ok: false,
            package: normalized,
            plugins: await listInstalledPlugins(),
            error: `Registry install failed: ${message}\nLocal fallback failed: ${localMessage}`,
          };
        }
      }

      appendLog('connect', 'system', `Plugin install failed for "${normalized}": ${message}`);
      return {
        ok: false,
        package: normalized,
        plugins: await listInstalledPlugins(),
        error: message,
      };
    }
  });

  ipcMain.handle('runtime:get-network', async () => {
    await refreshPeerCache();
    return getNetworkSnapshot();
  });

  ipcMain.handle('runtime:lookup-peer', async (_event, peerId: string) => {
    if (typeof peerId !== 'string' || peerId.trim().length === 0) {
      return { ok: false, peer: null, error: 'Invalid peerId' };
    }
    await refreshPeerCache();
    const peer = lookupPeer(peerId.trim());
    return { ok: Boolean(peer), peer, error: peer ? null : 'Peer not found' };
  });

  ipcMain.handle('runtime:touch-peer', (_event, peerId: string) => {
    if (typeof peerId !== 'string' || peerId.trim().length === 0) return { ok: false };
    return { ok: touchPeer(peerId.trim()) };
  });

  ipcMain.handle(
    'runtime:get-data',
    async (
      _event,
      endpoint: string,
      _options?: { port?: number; query?: Record<string, unknown> },
    ) => {
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
      const safeConfig = sanitizeDashboardConfigPayload(config);
      if (Object.keys(safeConfig).length === 0) {
        return { ok: false, data: null, error: 'No valid config keys provided', status: null };
      }
      try {
        const merged = await stakingSessions.reset(async () => {
          const config = await mergeConfig(safeConfig, ACTIVE_CONFIG_PATH);
          await stopPaymentsPortal();
          return config;
        });
        // Drop cached clients and the RPC backoff so the next read uses the
        // new chain config instead of answers from the old chain.
        invalidateChainClients();
        invalidateOnChainEnrichmentCache();
        return { ok: true, data: { config: merged }, error: null, status: 200 };
      } catch (err) {
        return { ok: false, data: null, error: err instanceof Error ? err.message : String(err), status: null };
      }
    },
  );

  ipcMain.handle('runtime:scan-network', async () => {
    try {
      await requestBuyerPeerRefresh();
      await refreshPeerCache();
      const snapshot = getNetworkSnapshot();
      return { ok: snapshot.ok, data: snapshot, error: snapshot.error, status: 200 };
    } catch (err) {
      await refreshPeerCache();
      const snapshot = getNetworkSnapshot();
      return {
        ok: false,
        data: snapshot,
        error: err instanceof Error ? err.message : String(err),
        status: null,
      };
    }
  });
}
