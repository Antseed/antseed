import assert from 'node:assert/strict'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { dashboardLinkPath, removeDashboardLink, runningDashboardLink, writeDashboardLink } from './dashboard-link.js'

test('a running seller\'s dashboard link is found, owner-only, and removed only by its writer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seller-dashboard-link-'))
  assert.equal(runningDashboardLink(dir), null)
  const url = 'http://127.0.0.1:3120/console/seller#seller-token=abc'
  await writeDashboardLink(dir, url)
  assert.equal(runningDashboardLink(dir), url)
  assert.equal(statSync(dashboardLinkPath(dir)).mode & 0o777, 0o600)
  await removeDashboardLink(dir, process.pid + 1)
  assert.equal(runningDashboardLink(dir), url, 'another process leaves it')
  await removeDashboardLink(dir)
  assert.equal(runningDashboardLink(dir), null)
  // A seller that died without cleaning up: its pid is gone.
  await writeDashboardLink(dir, url, 2 ** 22 + 12345)
  assert.equal(runningDashboardLink(dir), null)
})
