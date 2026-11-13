import { join } from 'node:path'

export function tunnelDir(dataDir: string): string { return join(dataDir, 'tunnel') }
export function tunnelPidFile(dataDir: string): string { return join(tunnelDir(dataDir), 'tunnel.pid') }
export function tunnelStateFile(dataDir: string): string { return join(tunnelDir(dataDir), 'tunnel.state.json') }
