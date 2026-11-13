import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'

const VERSION = '2026.8.2'

type Asset = { name: string; sha256: string; archive: boolean }

function assetForPlatform(): Asset {
  if (process.platform === 'darwin' && process.arch === 'arm64') return { name: 'cloudflared-darwin-arm64.tgz', sha256: '9042c2c5d8b2de78e60f313d5fb31b6c5c1cebde787a3caf1f2c9588084ac442', archive: true }
  if (process.platform === 'darwin' && process.arch === 'x64') return { name: 'cloudflared-darwin-amd64.tgz', sha256: 'f1727723c586500e2092368ae21871b3df7ddfd2cb097f22d81bee4a9c458bb4', archive: true }
  if (process.platform === 'linux' && process.arch === 'arm64') return { name: 'cloudflared-linux-arm64', sha256: '7747d94570fb390cf47dcb4f9555c193c6355cda9793f0d878d9049e5d6a7790', archive: false }
  if (process.platform === 'linux' && process.arch === 'x64') return { name: 'cloudflared-linux-amd64', sha256: 'fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2', archive: false }
  if (process.platform === 'win32' && (process.arch === 'x64' || process.arch === 'arm64')) return { name: 'cloudflared-windows-amd64.exe', sha256: 'c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5', archive: false }
  throw new Error(`Cloudflare Tunnel is not supported on ${process.platform}/${process.arch}.`)
}

export async function ensureCloudflared(dataDir: string): Promise<string> {
  const executable = join(dataDir, 'tunnel', 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  try {
    const existing = await readFile(executable)
    if (existing.length > 1_000_000) return executable
  } catch { /* install below */ }

  const asset = assetForPlatform()
  const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${asset.name}`)
  if (!response.ok) throw new Error(`cloudflared download failed with HTTP ${response.status}.`)
  const downloaded = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(downloaded).digest('hex')
  if (digest !== asset.sha256) throw new Error('cloudflared download checksum did not match the pinned release.')
  const binary = asset.archive ? extractFirstTarFile(gunzipSync(downloaded)) : downloaded
  await mkdir(join(dataDir, 'tunnel', 'bin'), { recursive: true })
  const temporary = `${executable}.tmp`
  await writeFile(temporary, binary, { mode: 0o755 })
  await rename(temporary, executable)
  if (process.platform !== 'win32') await chmod(executable, 0o755)
  return executable
}

function extractFirstTarFile(tar: Buffer): Buffer {
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8)
    const type = header[156]
    const bodyStart = offset + 512
    if (name && (type === 0 || type === 48) && size > 0) return tar.subarray(bodyStart, bodyStart + size)
    offset = bodyStart + Math.ceil(size / 512) * 512
  }
  throw new Error('cloudflared archive did not contain an executable.')
}
