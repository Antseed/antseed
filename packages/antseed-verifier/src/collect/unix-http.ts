import { request } from 'node:http'

/** POST JSON to a unix-socket HTTP server and read the whole response body. */
export function postUnix(
  socketPath: string,
  path: string,
  body: string,
  { timeoutMs = 20_000, timeoutMessage = 'unix socket request timed out' }: { timeoutMs?: number; timeoutMessage?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error(timeoutMessage)))
    req.end(body)
  })
}
