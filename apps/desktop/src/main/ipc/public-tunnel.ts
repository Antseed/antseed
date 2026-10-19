import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ipcMain, shell } from 'electron';
import type { ProcessManager } from '../runtime/process-manager.js';
import { resolveBuyerProxyPort } from '../runtime/active-config.js';
import { resolveConnectDataDir } from '../runtime/process-manager.js';
import { loadPublicTunnelSettings, savePublicTunnelSettings, type TunnelProvider } from '../public-tunnel/store.js';
import { createPublicTunnelLifecycle, type PublicTunnelStatus } from '../public-tunnel/lifecycle.js';
import { createTunnelConsole, parseTunnelLocation } from '../public-tunnel/console.js';
import { consoleUpdatePaths, consoleUpdaterEnv } from '../public-tunnel/console-updates.js';

const STATUS_ATTEMPTS = 60;
const STATUS_INTERVAL_MS = 250;

function statePath(): string {
  return path.join(resolveConnectDataDir(), 'tunnel', 'tunnel.state.json');
}

function parseTunnelProvider(value: unknown): TunnelProvider | null {
  if (value === 'cloudflare' || value === 'ngrok') return value;
  return null;
}

function providerTokenName(provider: TunnelProvider): string {
  return provider === 'ngrok' ? 'ngrok authtoken' : 'Cloudflare tunnel token';
}

async function readStatus(processManager: ProcessManager): Promise<PublicTunnelStatus> {
  const running = processManager.getState().some((state) => state.mode === 'tunnel' && state.running);
  let baseUrl: string | null = null;
  let runningProvider: TunnelProvider | null = null;
  try {
    const state = JSON.parse(await readFile(statePath(), 'utf8')) as Record<string, unknown>;
    baseUrl = typeof state.baseUrl === 'string' ? state.baseUrl : null;
    runningProvider = parseTunnelProvider(state.provider);
  } catch { /* not ready */ }
  const settings = await loadPublicTunnelSettings();
  return {
    configured: settings !== null,
    configuredProviders: Object.keys(settings?.providers ?? {}) as TunnelProvider[],
    activeProvider: runningProvider ?? settings?.activeProvider ?? null,
    running,
    baseUrl,
  };
}

async function waitForBaseUrl(processManager: ProcessManager): Promise<PublicTunnelStatus> {
  for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt += 1) {
    const status = await readStatus(processManager);
    if (status.baseUrl || !status.running) return status;
    await new Promise((resolve) => setTimeout(resolve, STATUS_INTERVAL_MS));
  }
  return readStatus(processManager);
}

export function registerPublicTunnelIpc(deps: { processManager: ProcessManager }) {
  const { processManager } = deps;
  const lifecycle = createPublicTunnelLifecycle({
    loadSettings: loadPublicTunnelSettings,
    saveSettings: savePublicTunnelSettings,
    isRunning: () => processManager.getState().some((state) => state.mode === 'tunnel' && state.running),
    startProcess: async ({ provider, buyerPort, tunnelToken, publicUrl, apiKey }) => {
      await processManager.start({
        mode: 'tunnel',
        tunnelBuyerPort: buyerPort,
        env: {
          ANTSEED_TUNNEL_PROVIDER: provider,
          ANTSEED_TUNNEL_TOKEN: tunnelToken,
          CLOUDFLARED_TUNNEL_TOKEN: provider === 'cloudflare' ? tunnelToken : '',
          NGROK_AUTHTOKEN: provider === 'ngrok' ? tunnelToken : '',
          ANTSEED_TUNNEL_PUBLIC_URL: publicUrl,
          ANTSEED_TUNNEL_API_KEY: apiKey,
          // The console's Update button asks the app to update itself.
          ...consoleUpdaterEnv(consoleUpdatePaths(resolveConnectDataDir())),
        },
      });
    },
    stopProcess: () => processManager.stop('tunnel').then(() => undefined),
    resolveBuyerPort: resolveBuyerProxyPort,
    waitForReady: () => waitForBaseUrl(processManager),
  });
  const tunnelConsole = createTunnelConsole({
    readLocation: async () => {
      if (!processManager.getState().some((state) => state.mode === 'tunnel' && state.running)) return null;
      try {
        return parseTunnelLocation(JSON.parse(await readFile(statePath(), 'utf8')));
      } catch {
        return null;
      }
    },
    dataDir: resolveConnectDataDir,
    fetch: (url) => fetch(url, { signal: AbortSignal.timeout(3000) }),
    runCli: async (args) => (await processManager.runCliCommand(args, 'tunnel', { logStdout: false })).stdout,
    openExternal: (url) => shell.openExternal(url),
  });
  ipcMain.handle('public-tunnel:get-console-status', () => tunnelConsole.status());
  ipcMain.handle('public-tunnel:claim-console', () => tunnelConsole.claim());
  ipcMain.handle('public-tunnel:get-status', () => readStatus(processManager));
  ipcMain.handle('public-tunnel:configure', async (_event, input: unknown) => {
    if (!input || typeof input !== 'object') return { ok: false, error: 'Tunnel settings are required.' };
    const raw = input as Record<string, unknown>;
    const provider = parseTunnelProvider(raw.provider) ?? 'cloudflare';
    const tunnelToken = typeof raw.tunnelToken === 'string' ? raw.tunnelToken.trim() : '';
    const publicUrlInput = typeof raw.publicUrl === 'string' ? raw.publicUrl.trim() : '';
    let publicUrl = '';
    if (tunnelToken.length < 20) {
      return { ok: false, error: `Enter a valid ${providerTokenName(provider)}.` };
    }
    if (publicUrlInput) {
      try {
        const parsed = new URL(publicUrlInput);
        if (parsed.protocol !== 'https:') throw new Error();
        publicUrl = parsed.origin;
      } catch {
        return { ok: false, error: 'Enter a valid public https:// hostname.' };
      }
    } else if (provider === 'cloudflare') {
      return { ok: false, error: 'Enter the public https:// hostname configured for this Cloudflare tunnel.' };
    }
    const existing = await loadPublicTunnelSettings();
    const apiKey = existing?.apiKey ?? `antseed_${randomBytes(24).toString('base64url')}`;
    await savePublicTunnelSettings({
      activeProvider: provider,
      providers: { ...existing?.providers, [provider]: { tunnelToken, publicUrl } },
      apiKey,
      enabled: existing?.enabled ?? false,
    });
    return { ok: true, status: await readStatus(processManager) };
  });
  ipcMain.handle('public-tunnel:start', async (_event, input: unknown) => {
    const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const requestedProvider = parseTunnelProvider(raw.provider);
    return lifecycle.start(requestedProvider ?? undefined);
  });
  ipcMain.handle('public-tunnel:stop', async () => {
    await lifecycle.stop();
    return { ok: true, status: await readStatus(processManager) };
  });
  ipcMain.handle('public-tunnel:get-api-key', async () => ({ apiKey: (await loadPublicTunnelSettings())?.apiKey ?? null }));
  return { restoreAtLaunch: lifecycle.restore };
}
