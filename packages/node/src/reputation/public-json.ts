import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

export function isPublicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [first = 0, second = 0] = address.split('.').map(Number);
  return !(first === 0 || first === 10 || first === 127 || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && [0, 2, 168].includes(second))
    || (first === 198 && [18, 19, 51].includes(second)) || (first === 203 && second === 0));
}

export function publicHttpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || isIP(url.hostname)
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(url.hostname) || !url.hostname.includes('.')) {
    throw new Error('Public HTTPS hostname required');
  }
  return url;
}

export async function fetchPublicJson(value: string, options: { maxBytes?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
  const url = publicHttpsUrl(value);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, options.timeoutMs ?? 8_000);
  try {
    return await new Promise<unknown>((resolve, reject) => {
      if (controller.signal.aborted) { reject(new Error('Public data request aborted')); return; }
      controller.signal.addEventListener('abort', () => reject(new Error('Public data request timed out')), { once: true });
      void lookup(url.hostname, { all: true, family: 4 }).then((addresses) => {
        if (controller.signal.aborted) return;
        if (!addresses.length || addresses.some(({ address }) => !isPublicIpv4(address))) {
          throw new Error('Non-public DNS address');
        }
        const address = addresses[0]!.address;
        const req = request(url, {
          signal: controller.signal,
          family: 4,
          headers: { accept: 'application/json', 'user-agent': 'AntSeed-public-history/1', 'accept-encoding': 'identity' },
          lookup: (_hostname, _options, callback) => callback(null, address, 4),
        }, (response) => {
          if (response.statusCode !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
            response.destroy();
            reject(new Error(`Public data HTTP ${response.statusCode}`));
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > (options.maxBytes ?? 2_000_000)) {
              response.destroy(new Error('Public data response too large'));
            } else {
              chunks.push(chunk);
            }
          });
          response.on('error', reject);
          response.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
            catch (error) { reject(error); }
          });
        });
        req.on('error', reject);
        req.end();
      }).catch(reject);
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export const fetchPublicProof: typeof fetch = async (input, init) => {
  const url = requestUrl(input);
  const data = await fetchPublicJson(url, { maxBytes: 16_384, signal: init?.signal ?? undefined });
  return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
};
