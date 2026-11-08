import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
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
  stop: () => Promise<void>;
  start: () => Promise<void>;
  buyerPort: () => Promise<number>;
  portInUse: (port: number) => Promise<boolean>;
  onForeignBuyer: (port: number) => void;
}): Promise<string | null> {
  await ops.stop();
  const port = await ops.buyerPort();
  if (await ops.portInUse(port)) {
    ops.onForeignBuyer(port);
    return foreignBuyerMessage(port);
  }
  await ops.start();
  return null;
}

export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(1_000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { resolve(false); });
  });
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
