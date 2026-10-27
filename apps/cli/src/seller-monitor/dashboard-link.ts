import { readFileSync } from 'node:fs'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Where a running seller keeps its dashboard link: owner-only, like the data dir's other secrets. */
export function dashboardLinkPath(dataDir: string): string {
  return join(dataDir, 'seller-dashboard.json')
}

interface DashboardLink {
  url: string
  pid: number
}

export async function writeDashboardLink(dataDir: string, url: string, pid = process.pid): Promise<void> {
  const path = dashboardLinkPath(dataDir)
  const temp = `${path}.${pid}.tmp`
  await writeFile(temp, JSON.stringify({ url, pid } satisfies DashboardLink), { mode: 0o600 })
  await rename(temp, path)
}

/** Removes the link only if this process wrote it. */
export async function removeDashboardLink(dataDir: string, pid = process.pid): Promise<void> {
  const link = readLink(dataDir)
  if (link && link.pid === pid) await unlink(dashboardLinkPath(dataDir)).catch(() => {})
}

/** The link of the dashboard a running `seller start` serves for this data dir, if any. */
export function runningDashboardLink(dataDir: string): string | null {
  const link = readLink(dataDir)
  if (!link) return null
  try {
    process.kill(link.pid, 0)
  } catch (error) {
    // EPERM: alive but another user's; anything else: gone.
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return null
  }
  return link.url
}

function readLink(dataDir: string): DashboardLink | null {
  try {
    const parsed = JSON.parse(readFileSync(dashboardLinkPath(dataDir), 'utf8')) as Partial<DashboardLink>
    return typeof parsed.url === 'string' && Number.isInteger(parsed.pid) ? { url: parsed.url, pid: parsed.pid! } : null
  } catch {
    return null
  }
}

/** The token of the link a previous run left (a restart keeps the link), to serve the dashboard under it again. */
export function previousDashboardToken(dataDir: string): string | null {
  const link = readLink(dataDir)
  if (!link) return null
  try {
    const token = new URL(link.url).hash.replace(/^#seller-token=/, '')
    return /^[0-9a-f]{48}$/.test(token) ? token : null
  } catch {
    return null
  }
}
