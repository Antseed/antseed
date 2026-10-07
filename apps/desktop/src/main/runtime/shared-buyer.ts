import type { ProcessManager } from './process-manager.js';

export function assertAttachOnlyRuntime(mode: string, compatible: boolean, attachOnly: boolean): void {
  if (!attachOnly) return;
  if (mode !== 'connect' || !compatible) {
    throw new Error('This desktop is attached to an isolated sandbox. Start the sandbox buyer first; starting another runtime is disabled.');
  }
}

export async function isCompatibleSharedBuyer(port: number, timeoutMs = 1_200): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/_antseed/status`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function refreshSharedBuyerAttachment(
  processManager: ProcessManager,
  port: number,
): Promise<boolean> {
  if (!processManager.isAttached('connect')) {
    return false;
  }
  if (await isCompatibleSharedBuyer(port)) {
    return true;
  }
  processManager.detach('connect', `Shared buyer proxy on 127.0.0.1:${port} is no longer reachable.`);
  return false;
}
