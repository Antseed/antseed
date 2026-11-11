/**
 * What a runtime start does before anything is spawned. The Start button
 * (ipc/runtime.ts) and a chat that finds no buyer (main.ts) both go through
 * here, so neither can start a runtime the other would have refused.
 */
import { isDesktopDebugEnabled } from '../app-context.js';
import { ensureSecureIdentity, secureIdentityEnv } from '../identity.js';
import type { ProcessManager, RuntimeMode, RuntimeProcessState, StartOptions } from './process-manager.js';

/**
 * The signer a runtime starts with. While the stored key can't be read this
 * throws the reason and records it in that runtime's status and log: a runtime
 * started without the key would use another wallet.
 */
export async function identityEnvForStart(processManager: ProcessManager, mode: RuntimeMode): Promise<Record<string, string>> {
  await ensureSecureIdentity();
  try {
    return secureIdentityEnv();
  } catch (err) {
    processManager.recordStartFailure(mode, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export type ChatBuyerStartDeps = {
  processManager: ProcessManager;
  getCombinedProcessState: () => RuntimeProcessState[];
  appendLog: (mode: RuntimeMode, stream: 'stdout' | 'stderr' | 'system', line: string) => void;
};

/**
 * Starts the buyer for a chat that found no proxy. True when the buyer is
 * running or was started, false when it didn't come up. A signer that can't be
 * read throws instead, so the chat shows that reason.
 */
export async function startBuyerForChat(deps: ChatBuyerStartDeps): Promise<boolean> {
  const { appendLog, getCombinedProcessState, processManager } = deps;
  const connectState = getCombinedProcessState().find((state) => state.mode === 'connect');
  if (connectState?.running) {
    return true;
  }

  const identityEnv = await identityEnvForStart(processManager, 'connect');

  const startOptions: StartOptions = {
    mode: 'connect',
    router: 'local',
    ...(isDesktopDebugEnabled() ? { verbose: true } : {}),
    env: {
      ...(isDesktopDebugEnabled() ? { ANTSEED_DEBUG: '1' } : {}),
      ...identityEnv,
    },
  };

  try {
    await processManager.start(startOptions);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('already running')) {
      return true;
    }
    appendLog('connect', 'system', `Chat-triggered buyer runtime start failed: ${message}`);
    return false;
  }
}
