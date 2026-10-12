import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { teeControlFileName, type TeeSnapshot } from '@antseed/node/tee-status';

export async function requestTeeSnapshot(directory: string, port: number, peerId?: string): Promise<TeeSnapshot> {
  const file = join(directory, teeControlFileName(port));
  const metadata = await stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      throw new Error('TEE verification credentials are missing. Ensure the buyer supports verification and uses the same data directory as desktop (ANTSEED_DESKTOP_CONNECT_DATA_DIR).');
    }
    throw error;
  });
  if (process.platform !== 'win32' && ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.())) {
    throw new Error('Unsafe buyer verification credential permissions');
  }
  const credential = JSON.parse(await readFile(file, 'utf8')) as { token?: string; sessionId?: string; port?: number };
  if (credential.port !== port || typeof credential.token !== 'string' || !/^[a-f0-9]{64}$/.test(credential.token)
    || typeof credential.sessionId !== 'string') throw new Error('Invalid buyer verification credential');
  const response = await fetch(`http://127.0.0.1:${port}/_antseed/verification${peerId === undefined ? '' : '/check'}`, {
    method: peerId === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' },
    ...(peerId === undefined ? {} : { body: JSON.stringify({ peerId }) }),
    signal: AbortSignal.timeout(peerId === undefined ? 2500 : 35_000),
    redirect: 'error',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(error.error ?? `Buyer verification unavailable (${response.status})`);
  }
  const snapshot = await response.json() as TeeSnapshot;
  if (snapshot.sessionId !== credential.sessionId || !Array.isArray(snapshot.evidence)
    || typeof snapshot.verificationEnabled !== 'boolean') throw new Error('Buyer verification session changed');
  return snapshot;
}
