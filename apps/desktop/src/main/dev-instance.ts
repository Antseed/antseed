import path from 'node:path';
import { machineWideChangesDisabled } from './runtime/attach-only.js';

const MULTI_INSTANCE_ENV = 'ANTSEED_DESKTOP_MULTI_INSTANCE';

export function isMultiInstanceDevelopment(): boolean {
  return process.env[MULTI_INSTANCE_ENV] === '1';
}

// Connected-app config patches live in other apps' files under HOME. A testbench
// desktop never patched them (startup refuses), so its stop and quit must not
// unpatch the real desktop's connections either.
export function shouldRemoveSharedConfigPatches(reason: 'disconnect' | 'shutdown'): boolean {
  if (machineWideChangesDisabled()) return false;
  return reason === 'disconnect' || !isMultiInstanceDevelopment();
}

export function desktopInstanceName(): string {
  return process.env['ANTSEED_DESKTOP_INSTANCE']?.trim() ?? '';
}

function envPath(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? path.resolve(value) : null;
}

export function desktopUserDataDir(): string | null {
  return envPath('ANTSEED_DESKTOP_USER_DATA_DIR');
}

export function desktopSystemProxyDataDir(): string | null {
  return envPath('ANTSEED_SYSTEM_PROXY_DATA_DIR');
}

export function desktopSystemProxyCliDataDir(): string | null {
  const dataDir = desktopSystemProxyDataDir();
  return dataDir ? path.dirname(dataDir) : null;
}
