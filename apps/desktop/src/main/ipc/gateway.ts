/**
 * IPC surface for the gateway: which one the desktop uses (local or remote),
 * its key mode, key rotation, and links into its console.
 */
import { clipboard, ipcMain, shell } from 'electron';
import {
  checkRemoteGateway,
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
  remoteGatewayFor,
  updateGatewaySettings,
} from '../gateway/settings.js';
import { reconnectAllApps } from '../connected-apps/patching/connection.js';
import { findConnectableProfile } from '../connected-apps/patching/profiles.js';
import { openAgent } from '../agent-open.js';
import type { GatewayEndpointInfo, GatewaySettingsPatch } from '../../shared/gateway-types.js';
import { readGatewayRewards } from '../gateway/rewards.js';
import { createSavingsReader } from '../gateway/savings.js';
import { fetchBuyerProxyJson } from '../payments/buyer-channels.js';
import { resolveServiceIdHashes } from '../payments/service-hash-resolver.js';
import { BAKED_COMPARABLE_PRICES_URL } from '../generated/baked-defaults.js';
import { ensureSecureIdentity, getSecureIdentity } from '../identity.js';
import {
  agentSetupPrompt,
  installAgentSkills,
  listAgentSkillTargets,
  removeAgentSkills,
  syncAgentSkills,
} from '../agent-skills.js';

const COMPARABLE_PRICES_TIMEOUT_MS = 8_000;

/** Retail prices come from ANTSEED_COMPARABLE_PRICES_URL (empty turns them off) or the release build's baked default. */
function comparablePricesUrl(): string | null {
  const env = process.env.ANTSEED_COMPARABLE_PRICES_URL;
  return env !== undefined ? env.trim() || null : BAKED_COMPARABLE_PRICES_URL;
}

const readGatewaySavings = createSavingsReader({
  pricesUrl: comparablePricesUrl,
  fetchJson: async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(COMPARABLE_PRICES_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Retail prices answered ${response.status}`);
    return response.json();
  },
  readUsage: () => fetchBuyerProxyJson('/_antseed/buyer-usage'),
  resolveNames: resolveServiceIdHashes,
});

/** Agent skills get their own key in per-app key mode. */
const AGENT_SKILLS_APP = { name: 'agent-skills', label: 'Agent skills' };

function errorResult(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export type GatewayIpcDeps = {
  /** The gateway or its key changed: the chat's model list must reload. */
  onEndpointChanged: () => void;
};

/** Re-points installed skills at the current gateway and key. Asks for no key when none are installed. */
export async function syncInstalledAgentSkills(): Promise<void> {
  if (!listAgentSkillTargets().some((target) => target.installed)) return;
  await syncAgentSkills(await getGatewayEndpoint(AGENT_SKILLS_APP));
}

/** The settings or keys changed, but the agents' installed skills still hold the old ones. */
export function skillsNotUpdated(err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return `Saved, but the Antseed skills installed in your agents couldn't be updated (${reason}). They still use the old key or address: add Antseed to those agents again in Agents & apps.`;
}

export function registerGatewayIpc(deps: GatewayIpcDeps): void {
  /** Re-points every consumer; says why when the installed agent skills couldn't follow (null when they did). */
  const endpointChanged = async (restartApps: boolean): Promise<string | null> => {
    clearGatewayModelCache();
    clearRoutePreviewCache();
    deps.onEndpointChanged();
    await reconnectAllApps({ restart: restartApps });
    return syncInstalledAgentSkills().then(() => null, (err: unknown) => skillsNotUpdated(err));
  };

  ipcMain.handle('gateway:get-status', () => getGatewayStatus());

  ipcMain.handle('gateway:get-settings', () => ({ ...getGatewaySettings(), hasRemoteKey: hasRemoteKey() }));

  ipcMain.handle('gateway:update-settings', async (_event, opts: GatewaySettingsPatch) => {
    try {
      const patch = {
        ...(opts?.mode === 'local' || opts?.mode === 'remote' ? { mode: opts.mode } : {}),
        ...(opts?.remoteUrl !== undefined ? { remoteUrl: opts.remoteUrl } : {}),
        ...(opts?.remoteApiKey !== undefined ? { remoteApiKey: opts.remoteApiKey } : {}),
        ...(opts?.keyMode === 'shared' || opts?.keyMode === 'per-app' ? { keyMode: opts.keyMode } : {}),
      };
      // Checked before anything changes: a failed switch keeps the gateway that works.
      const remote = remoteGatewayFor(patch);
      if (remote) await checkRemoteGateway(remote);
      const before = getGatewaySettings();
      const after = updateGatewaySettings(patch);
      if (before.mode === 'local' && after.mode === 'remote') await stopLocalGateway();
      if (after.mode === 'local') await ensureLocalGateway();
      // The apps still have to follow the new settings if an old key couldn't be revoked.
      // Only a local gateway holds the per-app keys; a remote switch leaves them for the next local one.
      const cleanupFailure = after.mode === 'local'
        ? await revokeUnusedAppKeys().then(() => null, (err: unknown) => err)
        : null;
      const skillsFailure = await endpointChanged(true);
      if (cleanupFailure) return errorResult(cleanupFailure);
      if (skillsFailure) return { ok: false, error: skillsFailure };
      return { ok: true, settings: { ...getGatewaySettings(), hasRemoteKey: hasRemoteKey() } };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('gateway:rotate-keys', async () => {
    try {
      // Keys that were replaced before a failure still have to reach the apps.
      const failure = await rotateLocalKeys().then(() => null, (err: unknown) => err);
      const skillsFailure = await endpointChanged(true);
      if (failure) return errorResult(failure);
      return skillsFailure ? { ok: false, error: skillsFailure } : { ok: true };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('gateway:get-endpoint', async (_event, opts?: { app?: string }): Promise<GatewayEndpointInfo> => {
    try {
      // In per-app key mode an app has its own key, which is the one to hand it.
      const profile = opts?.app ? findConnectableProfile(opts.app) : undefined;
      if (opts?.app && !profile) throw new Error(`Unknown app: ${opts.app}`);
      const endpoint = await getGatewayEndpoint(profile ? { name: profile.name, label: profile.label } : undefined);
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

  // Usage is read from this app's buyer, so a remote gateway (paying from its
  // own wallet) has nothing here to compare.
  ipcMain.handle('gateway:get-savings', async () => {
    if (getGatewaySettings().mode !== 'local') return null;
    return readGatewaySavings().catch(() => null);
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

  ipcMain.handle('agent-skills:open', async (_event, opts: { id?: string }) => {
    try {
      return await openAgent(String(opts?.id ?? ''));
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
