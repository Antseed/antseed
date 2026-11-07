/**
 * IPC surface for the gateway: which one the desktop uses (local or remote),
 * its key mode, key rotation, and links into its console.
 */
import { clipboard, ipcMain, shell } from 'electron';
import {
  getGatewayEndpoint,
  getGatewayKeyInfo,
  getGatewayPrivacy,
  setGatewayPrivacy,
  getGatewayStatus,
  gatewayConsoleUrl,
  revokeUnusedAppKeys,
  rotateLocalKeys,
  stopLocalGateway,
  ensureLocalGateway,
} from '../gateway/service.js';
import { clearGatewayModelCache } from '../gateway/models.js';
import { clearRoutePreviewCache } from '../gateway/route-preview.js';
import {
  getGatewaySettings,
  hasRemoteKey,
  updateGatewaySettings,
  type GatewayKeyMode,
  type GatewayMode,
} from '../gateway/settings.js';
import { reconnectAllApps } from '../connected-apps/patching/connection.js';
import { readGatewayRewards } from '../gateway/rewards.js';
import { ensureSecureIdentity, getSecureIdentity } from '../identity.js';
import {
  agentSetupPrompt,
  installAgentSkills,
  listAgentSkillTargets,
  removeAgentSkills,
  syncAgentSkills,
} from '../agent-skills.js';

/** Agent skills get their own key in per-app key mode. */
const AGENT_SKILLS_APP = { name: 'agent-skills', label: 'Agent skills' };

function errorResult(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export type GatewayIpcDeps = {
  /** The gateway or its key changed: the chat's model list must reload. */
  onEndpointChanged: () => void;
};

export function registerGatewayIpc(deps: GatewayIpcDeps): void {
  const endpointChanged = async (restartApps: boolean) => {
    clearGatewayModelCache();
    clearRoutePreviewCache();
    deps.onEndpointChanged();
    await reconnectAllApps({ restart: restartApps });
    await syncAgentSkills(await getGatewayEndpoint(AGENT_SKILLS_APP)).catch(() => undefined);
  };

  ipcMain.handle('gateway:get-status', () => getGatewayStatus());

  ipcMain.handle('gateway:get-settings', () => ({ ...getGatewaySettings(), hasRemoteKey: hasRemoteKey() }));

  ipcMain.handle('gateway:update-settings', async (_event, opts: {
    mode?: GatewayMode;
    remoteUrl?: string | null;
    remoteApiKey?: string | null;
    keyMode?: GatewayKeyMode;
  }) => {
    try {
      const before = getGatewaySettings();
      const after = updateGatewaySettings({
        ...(opts?.mode === 'local' || opts?.mode === 'remote' ? { mode: opts.mode } : {}),
        ...(opts?.remoteUrl !== undefined ? { remoteUrl: opts.remoteUrl } : {}),
        ...(opts?.remoteApiKey !== undefined ? { remoteApiKey: opts.remoteApiKey } : {}),
        ...(opts?.keyMode === 'shared' || opts?.keyMode === 'per-app' ? { keyMode: opts.keyMode } : {}),
      });
      if (before.mode === 'local' && after.mode === 'remote') await stopLocalGateway();
      if (after.mode === 'local') await ensureLocalGateway();
      if (after.mode === 'remote') {
        // Fail loudly now rather than on the first chat: the URL and key must work together.
        const endpoint = await getGatewayEndpoint();
        const response = await fetch(`${endpoint.origin}/v1/models`, {
          headers: { authorization: `Bearer ${endpoint.apiKey}` },
          signal: AbortSignal.timeout(10_000),
        }).catch((err: unknown) => {
          throw new Error(`Could not reach ${endpoint.origin}: ${err instanceof Error ? err.message : String(err)}`);
        });
        if (response.status === 401 || response.status === 403) throw new Error('The gateway rejected this API key');
      }
      await revokeUnusedAppKeys();
      await endpointChanged(true);
      return { ok: true, settings: { ...getGatewaySettings(), hasRemoteKey: hasRemoteKey() } };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('gateway:rotate-keys', async () => {
    try {
      await rotateLocalKeys();
      await endpointChanged(true);
      return { ok: true };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('gateway:get-endpoint', async () => {
    try {
      const endpoint = await getGatewayEndpoint();
      return { ok: true, baseUrl: `${endpoint.origin}/v1`, origin: endpoint.origin, apiKey: endpoint.apiKey, mode: endpoint.mode };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('gateway:get-key-info', () => getGatewayKeyInfo());

  ipcMain.handle('gateway:get-privacy', async () => {
    try {
      return { ok: true, privacy: await getGatewayPrivacy() };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('gateway:set-privacy', async (_event, opts: { mode?: string }) => {
    try {
      const mode = opts?.mode === 'private' ? 'private' : 'anonymous';
      const privacy = await setGatewayPrivacy(mode);
      // Previews and the model list cached under the old policy would show the
      // wrong sellers and prices.
      clearRoutePreviewCache();
      clearGatewayModelCache();
      return { ok: true, privacy };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('gateway:get-rewards', async (_event, opts?: { force?: boolean }) => {
    try {
      // A remote gateway names its paying wallet; the local one pays from this app's wallet.
      let address = (await getGatewayKeyInfo())?.buyerAddress ?? null;
      if (!address && getGatewaySettings().mode === 'local') {
        await ensureSecureIdentity();
        address = getSecureIdentity()?.wallet.address ?? null;
      }
      if (!address) throw new Error('Your gateway did not report its wallet');
      return { ok: true, data: await readGatewayRewards(address, { force: opts?.force === true }) };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('agent-skills:list', () => listAgentSkillTargets());

  ipcMain.handle('agent-skills:install', async (_event, opts: { id?: string }) => {
    try {
      await installAgentSkills(String(opts?.id ?? ''), await getGatewayEndpoint(AGENT_SKILLS_APP));
      return { ok: true, targets: listAgentSkillTargets() };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('agent-skills:remove', async (_event, opts: { id?: string }) => {
    try {
      await removeAgentSkills(String(opts?.id ?? ''));
      return { ok: true, targets: listAgentSkillTargets() };
    } catch (err) {
      return errorResult(err);
    }
  });

  // The prompt holds the key, so it goes straight to the clipboard.
  ipcMain.handle('agent-skills:copy-prompt', async () => {
    try {
      clipboard.writeText(agentSetupPrompt(await getGatewayEndpoint(AGENT_SKILLS_APP)));
      return { ok: true };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('gateway:open-console', async (_event, opts: { path?: string }) => {
    try {
      const pathname = typeof opts?.path === 'string' ? opts.path : '';
      if (pathname && !/^\/?[\w\-/?=&.]*$/.test(pathname)) throw new Error('Invalid console path');
      await shell.openExternal(await gatewayConsoleUrl(pathname));
      return { ok: true };
    } catch (err) {
      return errorResult(err);
    }
  });
}
