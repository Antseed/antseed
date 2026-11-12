import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { portInUse as sharedPortInUse } from '@antseed/node/gateway-process';
import path from 'node:path';

/** A buyer the app doesn't run signs with its own key, so a new signer can't reach it. */
export function foreignBuyerMessage(port: number): string {
  return `Your new signer is saved, but a buyer started outside this app is still running on port ${port} with the old wallet. Stop that buyer: until then the app won't send requests through it.`;
}

/**
 * The gateway's buyer signs with the identity it started with, so a new one
 * needs a restart. Stopping the gateway stops a buyer it runs. One still on the
 * port is someone else's, and a new gateway would attach to it and keep paying
 * from the old wallet. Answers why it can't go ahead, or null once it has.
 */
export async function restartForNewIdentity(ops: {
  /** False while a remote gateway is in use: nothing local to restart, but the check still applies. */
  local: boolean;
  stop: () => Promise<void>;
  /**
   * Records that the signer changed, while nothing goes through the local
   * gateway: after it stops, or straight away with a remote gateway in use,
   * since the local one isn't running then and counts nothing until it starts.
   */
  checkpoint: () => Promise<void>;
  start: () => Promise<void>;
  buyerPort: () => Promise<number>;
  portInUse: (port: number) => Promise<boolean>;
  onForeignBuyer: (port: number) => void;
}): Promise<string | null> {
  if (ops.local) await ops.stop();
  await ops.checkpoint();
  const port = await ops.buyerPort();
  if (await ops.portInUse(port)) {
    // Recorded in remote mode too, so a later switch to this computer can't attach to it.
    ops.onForeignBuyer(port);
    return ops.local ? foreignBuyerMessage(port) : null;
  }
  if (ops.local) await ops.start();
  return null;
}

/** Whether a buyer still listens on this port (a second's grace: it may be busy). */
export function portInUse(port: number): Promise<boolean> {
  return sharedPortInUse(port, 1_000);
}

/**
 * The port of a buyer found on the old wallet after a signer import. Kept on
 * disk: quitting and reopening must not let the app attach to that buyer again.
 * Cleared once the port is free.
 */
export function createForeignBuyerGuard(file: string) {
  return {
    get(): number | null {
      try {
        const port = (JSON.parse(readFileSync(file, 'utf8')) as { port?: unknown }).port;
        return typeof port === 'number' ? port : null;
      } catch {
        return null;
      }
    },
    set(port: number): void {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ port })}\n`, 'utf8');
    },
    clear(): void {
      rmSync(file, { force: true });
    },
  };
}
