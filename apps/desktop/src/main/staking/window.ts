import { clipboard, shell, type BrowserWindow } from 'electron';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createAntsServer, type AntsServerOptions } from '@antseed/ants';
import { stakingLaunchUrl, type StakingSession } from './session.js';

/** Keep the localhost session alive; wallet extensions run in the system browser. */
export async function createStakingWindowSession(
  options: Omit<AntsServerOptions, 'port' | 'host'>,
  _getParent: () => BrowserWindow | null,
): Promise<StakingSession> {
  await access(fileURLToPath(new URL('ants-web/index.html', import.meta.resolve('@antseed/ants'))));
  const server = await createAntsServer({ ...options, signer: undefined, browserWallet: true, port: 0, host: '127.0.0.1' });
  try { await server.listen(); } catch (error) { await server.close(); throw error; }
  return {
    get busy() { return server.busy; },
    pauseWrites: () => server.pauseWrites(),
    async open(page) { await shell.openExternal(stakingLaunchUrl(server.url, page)); },
    async copyLink(page) { clipboard.writeText(stakingLaunchUrl(server.url, page)); },
    async close() { await server.close(); },
  };
}
