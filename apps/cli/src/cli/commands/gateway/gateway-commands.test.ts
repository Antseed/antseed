import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach, beforeEach, describe } from 'node:test'
import { Command } from 'commander'
import { AuthDb } from '../../../gateway/auth/db.js'
import { CONSOLE_LOCATION_SETTING } from '../../../gateway/console.js'
import { hashApiKey } from '../../../gateway/keys.js'
import { DEFAULT_WORKSPACE_ID, GatewayStore } from '../../../gateway/store.js'
import { printConsoleInfo, registerGatewayCommands } from './index.js'
import { gatewayCliRuntime } from './shared.js'

// Never ask a buyer that may be running on this machine; tests that need one inject it.
gatewayCliRuntime.buyerAddresses = async () => null

let dataDir: string

async function run(...args: string[]): Promise<string> {
  const program = new Command()
  program.exitOverride().option('--data-dir <path>')
  registerGatewayCommands(program)
  const lines: string[] = []
  const original = console.log
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')) }
  try {
    await program.parseAsync(['node', 'antseed', '--data-dir', dataDir, 'gateway', ...args])
  } finally {
    console.log = original
  }
  return lines.join('\n')
}

async function runJson<T = Record<string, unknown>>(...args: string[]): Promise<T> {
  return JSON.parse(await run(...args, '--json')) as T
}

function withStore<T>(fn: (store: GatewayStore) => T): T {
  const store = new GatewayStore(dataDir)
  try {
    return fn(store)
  } finally {
    store.close()
  }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'antseed-gateway-cli-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('gateway console-link', () => {
  test('prints a localhost setup link until the console has an owner, then its URL', async () => {
    const first = await runJson<{ setupRequired: boolean; setupLink: string; url: string }>('console-link')
    assert.equal(first.setupRequired, true)
    assert.match(first.setupLink, /^http:\/\/localhost:8379\/console\/setup#[A-Za-z0-9_-]{40,}$/)
    assert.equal(first.url, 'http://localhost:8379/console')

    // A new link replaces the previous one.
    const second = await runJson<{ setupLink: string }>('console-link')
    assert.notEqual(second.setupLink, first.setupLink)
    withStore((store) => {
      const db = new AuthDb(store.database, () => Date.now())
      assert.equal(db.consumeSetupToken(first.setupLink.split('#')[1]!), false)
      assert.equal(db.consumeSetupToken(second.setupLink.split('#')[1]!), true)
    })

    withStore((store) => store.createOwner({ label: 'Owner', email: 'owner@example.com' }))
    const claimed = await runJson<{ setupRequired: boolean; setupLink: string | null; url: string }>('console-link')
    assert.equal(claimed.setupRequired, false)
    assert.equal(claimed.setupLink, null)
    const text = await run('console-link')
    assert.match(text, /already has an owner/)
    assert.match(text, /gateway member invite/)
  })

  test('uses the running gateway\'s location, overridable by flags', async () => {
    withStore((store) => store.setSetting(CONSOLE_LOCATION_SETTING, { publicUrl: null, port: 9555 }))
    assert.match((await runJson<{ setupLink: string }>('console-link')).setupLink, /^http:\/\/localhost:9555\/console\/setup#/)

    withStore((store) => store.setSetting(CONSOLE_LOCATION_SETTING, { publicUrl: 'https://llm.example.test', port: 9555 }))
    assert.match((await runJson<{ setupLink: string }>('console-link')).setupLink, /^https:\/\/llm\.example\.test\/console\/setup#/)

    const flagged = await runJson<{ setupLink: string }>('console-link', '--public-url', 'https://other.example.test/')
    assert.match(flagged.setupLink, /^https:\/\/other\.example\.test\/console\/setup#/)
    await assert.rejects(run('console-link', '--public-url', 'ftp://nope.example.test'), /https:\/\//)
  })
})

describe('gateway workspace', () => {
  test('creates and lists workspaces', async () => {
    const created = await runJson<{ id: string; name: string; identity: string; walletAddress: string | null; limitsUsd: Record<string, string | null> }>(
      'workspace', 'create', '--name', 'Research Lab', '--weekly-limit', '25',
    )
    assert.equal(created.name, 'Research Lab')
    assert.equal(created.identity, 'ws-research-lab')
    assert.match(created.walletAddress ?? '', /^0x[0-9a-fA-F]{40}$/)
    assert.equal(created.limitsUsd['weekly'], '25.000000')
    assert.equal(created.limitsUsd['daily'], null)

    const shared = await runJson<{ identity: string }>('workspace', 'create', '--name', 'Shared', '--identity', 'default')
    assert.equal(shared.identity, 'default')
    await assert.rejects(run('workspace', 'create', '--name', 'X', '--identity', 'missing'), /Unknown buyer identity/)

    const list = await runJson<Array<{ id: string; name: string; isDefault: boolean }>>('workspace', 'list')
    assert.deepEqual(list.map((workspace) => workspace.name), ['Default', 'Research Lab', 'Shared'])
    assert.equal(list[0]!.isDefault, true)
    assert.match(await run('workspace', 'list'), /Research Lab/)
  })
})

describe('gateway workspace wallet', () => {
  test('a desktop-style data dir with the buyer down shows the wallet as unknown and caches nothing', async () => {
    writeFileSync(join(dataDir, 'identity.key'), '12'.repeat(32))
    writeFileSync(join(dataDir, 'identity.enc'), 'encrypted')
    const shown = await run('workspace', 'show', 'Default')
    assert.match(shown, /Identity: default \(wallet unknown \(buyer not running\)\)/)
    const listed = await runJson<Array<{ walletAddress: string | null; walletNote?: string }>>('workspace', 'list')
    assert.equal(listed[0]!.walletAddress, null)
    assert.equal(listed[0]!.walletNote, 'unknown (buyer not running)')
    assert.equal(withStore((store) => store.defaultWorkspace().walletAddress), null)
  })
})

describe('gateway key', () => {
  test('creates keys in a workspace with weekly limits and changes them', async () => {
    const workspace = await runJson<{ id: string; identity: string }>('workspace', 'create', '--name', 'Team', '--identity', 'default')
    const key = await runJson<{ id: string; apiKey: string; workspaceId: string; identity: string; limitsUsd: Record<string, string | null> }>(
      'key', 'create', '--label', 'alice', '--workspace', 'team', '--weekly-limit', '10', '--monthly-limit', '30',
    )
    assert.equal(key.workspaceId, workspace.id)
    assert.equal(key.identity, 'default')
    assert.equal(key.limitsUsd['weekly'], '10.000000')
    assert.equal(key.limitsUsd['monthly'], '30.000000')

    assert.match(await run('key', 'limits', key.id, '--weekly-limit', 'none'), /30\.00 monthly|monthly/)
    withStore((store) => {
      const record = store.getKey(key.id)!
      assert.equal(record.limits.weekly, null)
      assert.equal(record.limits.monthly, 30_000_000)
    })

    await assert.rejects(run('key', 'create', '--label', 'x', '--workspace', 'team', '--identity', 'default'), /only one of/)
    await assert.rejects(run('key', 'create', '--label', 'x', '--workspace', 'nope'), /Unknown workspace/)
    await assert.rejects(run('key', 'limits', key.id), /--weekly-limit/)

    const plain = await runJson<{ workspaceId: string }>('key', 'create', '--label', 'bob')
    assert.equal(plain.workspaceId, DEFAULT_WORKSPACE_ID)
  })

  test('revoking a key ends its console sessions', async () => {
    const key = await runJson<{ id: string }>('key', 'create', '--label', 'carol')
    withStore((store) => new AuthDb(store.database, () => Date.now()).createSession({ kind: 'key', keyId: key.id }, { userAgent: null, ip: '127.0.0.1' }))
    await run('key', 'revoke', key.id)
    withStore((store) => {
      const count = store.database.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE key_id = ?').get(key.id) as { count: number }
      assert.equal(count.count, 0)
    })
  })
})

describe('gateway member', () => {
  test('invites a member with workspace roles and an invite link', async () => {
    const workspace = await runJson<{ id: string }>('workspace', 'create', '--name', 'Ops', '--identity', 'default')
    const invite = await runJson<{ memberId: string; url: string; orgRole: string; workspaces: Array<{ workspaceId: string; role: string }> }>(
      'member', 'invite', '--label', 'Bob', '--email', 'Bob@Example.com', '--workspace', 'Ops:admin', '--port', '9000',
    )
    assert.equal(invite.orgRole, 'member')
    assert.deepEqual(invite.workspaces, [{ workspaceId: workspace.id, role: 'admin' }])
    assert.match(invite.url, /^http:\/\/localhost:9000\/console\/invite#[A-Za-z0-9_-]{40,}$/)
    withStore((store) => {
      const member = store.getMember(invite.memberId)!
      assert.equal(member.status, 'invited')
      assert.equal(member.email, 'bob@example.com')
      assert.equal(store.memberWorkspaceRoles(member.id).get(workspace.id), 'admin')
      // The link's token is the one the store accepts.
      assert.equal(store.consumeInvite(hashApiKey(invite.url.split('#')[1]!), Date.now())?.id, member.id)
    })

    await assert.rejects(run('member', 'invite', '--label', 'Bob again', '--email', 'bob@example.com'), /already exists/)
    await assert.rejects(run('member', 'invite', '--label', 'X', '--role', 'boss'), /--role/)

    const plain = await runJson<{ workspaces: Array<{ workspaceId: string; role: string }> }>('member', 'invite', '--label', 'Dana')
    assert.deepEqual(plain.workspaces, [{ workspaceId: DEFAULT_WORKSPACE_ID, role: 'member' }])
    const admin = await runJson<{ workspaces: unknown[] }>('member', 'invite', '--label', 'Eve', '--role', 'admin')
    assert.deepEqual(admin.workspaces, [])

    const list = await runJson<Array<{ label: string; status: string }>>('member', 'list')
    assert.deepEqual(list.map((member) => [member.label, member.status]), [['Bob', 'active'], ['Dana', 'invited'], ['Eve', 'invited']])
  })

  test('disables a member, revoking their keys and sessions, and re-enables them', async () => {
    const { memberId, keyId } = withStore((store) => {
      store.createOwner({ label: 'Owner', email: 'owner@example.com' })
      const { token } = store.createInvite({ label: 'Frank', email: null, orgRole: 'member', workspaces: [], expiresAt: Date.now() + 60_000, createdBy: null })
      const member = store.consumeInvite(hashApiKey(token), Date.now())!
      const { key } = store.createKey({ label: 'frank', limits: { daily: null, monthly: null, total: null }, expiresAt: null, ownerMemberId: member.id })
      new AuthDb(store.database, () => Date.now()).createSession({ kind: 'member', memberId: member.id }, { userAgent: null, ip: '127.0.0.1' })
      return { memberId: member.id, keyId: key.id }
    })

    assert.match(await run('member', 'disable', memberId), /revoked 1 key/)
    withStore((store) => {
      assert.equal(store.getMember(memberId)!.status, 'disabled')
      assert.equal(store.getKey(keyId)!.status, 'revoked')
      const count = store.database.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE member_id = ?').get(memberId) as { count: number }
      assert.equal(count.count, 0)
    })

    await run('member', 'enable', memberId)
    withStore((store) => assert.equal(store.getMember(memberId)!.status, 'active'))

    const ownerId = withStore((store) => store.listMembers().find((member) => member.orgRole === 'owner')!.id)
    await assert.rejects(run('member', 'disable', ownerId), /only owner/)
    await assert.rejects(run('member', 'disable', 'mem_missing'), /Unknown member/)
  })
})

test('gateway start never prints the setup link (only console-link does)', () => {
  const lines: string[] = []
  let minted = 0
  const runtime = { console: { setupLink: () => { minted += 1; return 'https://x.example.test/console/setup#secret' } }, store: { isSetupComplete: () => false } }
  printConsoleInfo(runtime as never, 'https://x.example.test/console', (line) => lines.push(line))
  assert.equal(minted, 0)
  assert.ok(!lines.join('\n').includes('#secret'))
  assert.match(lines.join('\n'), /antseed gateway console-link/)
})

describe('gateway admin-token', () => {
  test('creates, lists and revokes management tokens', async () => {
    const created = await runJson<{ id: string; token: string; scope: string }>('admin-token', 'create', '--label', 'ci', '--scope', 'admin')
    assert.equal(created.scope, 'admin')
    assert.match(created.token, /^antseed_admin_/)
    withStore((store) => assert.equal(store.findAdminTokenBySecret(created.token)?.id, created.id))

    const readToken = await runJson<{ scope: string }>('admin-token', 'create', '--label', 'grafana')
    assert.equal(readToken.scope, 'read')
    await assert.rejects(run('admin-token', 'create', '--label', 'x', '--scope', 'root'), /--scope/)

    assert.equal((await runJson<unknown[]>('admin-token', 'list')).length, 2)
    assert.match(await run('admin-token', 'revoke', created.id), /Revoked/)
    assert.match(await run('admin-token', 'revoke', created.id), /already revoked/)
    assert.deepEqual((await runJson<Array<{ label: string }>>('admin-token', 'list')).map((token) => token.label), ['grafana'])
    withStore((store) => assert.equal(store.findAdminTokenBySecret(created.token), null))
    await assert.rejects(run('admin-token', 'revoke', 'adm_missing'), /Unknown token/)
  })

  test('tokens expire after 90 days unless told otherwise, and CLI changes are audited', async () => {
    const before = Date.now()
    const standard = await runJson<{ id: string; expiresAt: string }>('admin-token', 'create', '--label', 'ci')
    const expires = Date.parse(standard.expiresAt)
    assert.ok(expires >= before + 90 * 86_400_000 && expires <= Date.now() + 90 * 86_400_000)
    const week = await runJson<{ expiresAt: string }>('admin-token', 'create', '--label', 'week', '--expires-in-days', '7')
    assert.ok(Date.parse(week.expiresAt) <= Date.now() + 7 * 86_400_000)
    const forever = await runJson<{ expiresAt: string | null }>('admin-token', 'create', '--label', 'forever', '--no-expiry')
    assert.equal(forever.expiresAt, null)
    await assert.rejects(run('admin-token', 'create', '--label', 'x', '--expires-in-days', '400'), /at most 365/)
    await run('admin-token', 'revoke', standard.id)
    withStore((store) => {
      const entries = store.listAudit({ action: 'token' }).entries
      assert.deepEqual(entries.map((entry) => entry.action), ['token.revoke', 'token.create', 'token.create', 'token.create'])
      assert.deepEqual(entries[0]!.actor, { kind: 'cli', id: null, label: 'antseed CLI' })
    })
  })
})
