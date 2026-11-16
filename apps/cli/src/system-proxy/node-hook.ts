import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export function hookPath(dataDir: string): string {
  return join(dataDir, 'system-proxy', 'node-proxy-hook.cjs')
}

export async function writeNodeProxyHook(dataDir: string, port: number): Promise<string> {
  await mkdir(join(dataDir, 'system-proxy'), { recursive: true })
  const path = hookPath(dataDir)
  const caPath = join(dataDir, 'system-proxy', 'ca.crt').replace(/\\/g, '\\\\')

  // CJS — --require only supports CommonJS
  const content = `'use strict';
// Antseed System Proxy hook - auto-generated
try {
  const { setGlobalDispatcher, ProxyAgent } = require('undici');
  const fs = require('node:fs');
  let ca;
  try { ca = fs.readFileSync(${JSON.stringify(caPath)}); } catch (_) {}
  setGlobalDispatcher(new ProxyAgent({
    uri: 'http://127.0.0.1:${port}',
    connect: ca ? { ca } : undefined,
  }));
} catch (_) { /* undici unavailable or old Node.js — skip */ }
`
  await writeFile(path, content, 'utf8')
  return path
}
