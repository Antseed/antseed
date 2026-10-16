import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { chatTools, fetchPinned, htmlToText, isPrivateAddress, parseDuckDuckGo } from './tools.js'
import { mapChatModels, systemPrompt } from './routes.js'

const dirs: string[] = []
after(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))) })

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gc-chat-'))
  dirs.push(dir)
  return dir
}

/** Runs one tool's execute like the AI SDK would. */
async function run(tools: ReturnType<typeof chatTools>, name: string, input: unknown): Promise<any> {
  const execute = tools[name]?.execute
  assert.ok(execute, `tool ${name} exists`)
  return execute(input as never, { toolCallId: 't', messages: [] } as never)
}

test('private and local addresses are never fetched', () => {
  for (const address of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::', '::1', 'fd00::1', 'fe80::1',
    // IPv4-mapped (dotted and the hex form WHATWG URL produces), IPv4-compatible and NAT64 forms of private IPv4.
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', '0:0:0:0:0:ffff:a9fe:a9fe', '::7f00:1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b:1::1',
  ]) {
    assert.equal(isPrivateAddress(address), true, address)
  }
  for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '::ffff:808:808', '64:ff9b::808:808']) assert.equal(isPrivateAddress(address), false, address)
})

test('web_fetch refuses IPv6 literals that embed a private IPv4 address', async () => {
  const fetchImpl = (async () => new Response('reached')) as typeof fetch
  const tools = chatTools({ sandboxDir: await sandbox(), allowShell: false, fetchImpl, resolveHost: async () => ['93.184.216.34'] })
  for (const url of ['http://[::ffff:127.0.0.1]:8377/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:a00:1]/', 'http://[64:ff9b::127.0.0.1]/']) {
    await assert.rejects(run(tools, 'web_fetch', { url }), /private or local/, url)
  }
})

test('the pinned fetch connects to the checked address, never re-resolving the host', async () => {
  const server = createServer((req, res) => res.end(`host=${req.headers.host}`))
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  try {
    const { port } = server.address() as AddressInfo
    // `.invalid` never resolves in DNS, so a response proves the connection used the pinned address.
    const response = await fetchPinned(new URL(`http://pinned.invalid:${port}/`), ['127.0.0.1'], { headers: { accept: 'text/plain' } })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), `host=pinned.invalid:${port}`)
  } finally {
    server.close()
  }
})

test('web_fetch refuses local targets, including a public page that redirects to one', async () => {
  const fetchImpl = (async (url: URL | string) => {
    if (String(url).startsWith('https://public.example/')) return new Response('', { status: 302, headers: { location: 'http://127.0.0.1:8377/_antseed/channels' } })
    return new Response('nope')
  }) as typeof fetch
  const tools = chatTools({ sandboxDir: await sandbox(), allowShell: false, fetchImpl, resolveHost: async (host) => (host === 'public.example' ? ['93.184.216.34'] : ['127.0.0.1']) })
  await assert.rejects(run(tools, 'web_fetch', { url: 'http://localhost:8377/' }), /private or local/)
  await assert.rejects(run(tools, 'web_fetch', { url: 'https://public.example/' }), /private or local/)
  await assert.rejects(run(tools, 'web_fetch', { url: 'file:///etc/passwd' }), /Only http and https/)
})

test('web_fetch returns readable text from HTML', async () => {
  const fetchImpl = (async () => new Response('<html><head><style>x{}</style><script>alert(1)</script></head><body><h1>Title</h1><p>One &amp; two</p><ul><li>a</li><li>b</li></ul></body></html>', { headers: { 'content-type': 'text/html' } })) as typeof fetch
  const tools = chatTools({ sandboxDir: await sandbox(), allowShell: false, fetchImpl, resolveHost: async () => ['93.184.216.34'] })
  const page = await run(tools, 'web_fetch', { url: 'https://public.example/' })
  assert.equal(page.status, 200)
  assert.match(page.text, /Title\nOne & two/)
  assert.doesNotMatch(page.text, /alert|x\{\}/)
  assert.equal(htmlToText('<p>a&#39;b&#x41;</p>'), "a'bA")
})

test('DuckDuckGo results are parsed and their redirect links unwrapped', () => {
  const html = '<div class="result results_links results_links_deep web-result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fantseed.com%2F&amp;rut=x">Antseed <b>home</b></a><a class="result__snippet" href="#">Open market for <b>AI</b></a></div>'
  assert.deepEqual(parseDuckDuckGo(html), [{ title: 'Antseed home', url: 'https://antseed.com/', snippet: 'Open market for AI' }])
})

test('file tools stay inside the chat scratch directory', async () => {
  const root = await sandbox()
  const outside = await sandbox()
  await writeFile(join(outside, 'secret.txt'), 'top secret')
  const tools = chatTools({ sandboxDir: join(root, 'chat'), allowShell: false })
  assert.deepEqual(await run(tools, 'write_file', { path: 'notes/a.md', content: 'hello' }), { path: 'notes/a.md', bytes: 5 })
  assert.equal((await run(tools, 'read_file', { path: 'notes/a.md' })).content, 'hello')
  assert.deepEqual((await run(tools, 'list_files', {})).files.map((f: { path: string }) => f.path), ['notes'])
  await assert.rejects(run(tools, 'read_file', { path: '../../etc/passwd' }), /inside the chat/)
  await assert.rejects(run(tools, 'write_file', { path: '/tmp/x', content: 'x' }), /inside the chat/)
  // A symlink planted inside cannot be used to reach out.
  await mkdir(join(root, 'chat'), { recursive: true })
  await symlink(outside, join(root, 'chat', 'link'))
  await assert.rejects(run(tools, 'read_file', { path: 'link/secret.txt' }), /inside the chat/)
})

test('the shell is offered only when allowed, runs in the scratch directory without the gateway environment', async () => {
  const root = await sandbox()
  assert.equal(chatTools({ sandboxDir: root, allowShell: false })['run_command'], undefined)
  process.env['ANTSEED_TEST_SECRET'] = 'leak'
  try {
    const tools = chatTools({ sandboxDir: root, allowShell: true, approvedCommandCalls: new Set(['t']) })
    const result = await run(tools, 'run_command', { command: 'pwd; echo "s=${ANTSEED_TEST_SECRET:-none}"; exit 3' })
    assert.equal(result.exitCode, 3)
    assert.match(result.stdout, /s=none/)
    assert.ok(result.stdout.includes(root.split('/').pop()!))
  } finally {
    delete process.env['ANTSEED_TEST_SECRET']
  }
})

test('the shell refuses a call the user did not approve', async () => {
  const root = await sandbox()
  for (const approvedCommandCalls of [undefined, new Set<string>(), new Set(['another-call'])]) {
    const tools = chatTools({ sandboxDir: root, allowShell: true, ...(approvedCommandCalls ? { approvedCommandCalls } : {}) })
    await assert.rejects(run(tools, 'run_command', { command: 'touch ran' }), /not approved/)
  }
  await assert.rejects(stat(join(root, 'ran')), /ENOENT/)
})

test('chat models: text only, tool-capable first, cheapest offer and peers by reputation', () => {
  const models = mapChatModels({
    data: [
      { id: 'img', type: 'image', peers: [] },
      { id: 'plain', name: 'Plain', type: 'text', capability_coverage: { tool_use: 0 }, peers: [{ peerId: 'AA', inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 }] },
      {
        id: 'agent', name: 'Agent', type: 'text', capability_coverage: { tool_use: 2, reasoning: 1 },
        peers: [
          { peerId: 'BB', displayName: ' Beta ', inputUsdPerMillion: 2, outputUsdPerMillion: 4, effectiveReputationScore: 50, capabilities: { toolUse: true } },
          { peerId: 'CC', inputUsdPerMillion: 1, outputUsdPerMillion: 5, reputationScore: 90, capabilities: { toolUse: false } },
        ],
      },
    ],
  })
  assert.deepEqual(models.map((m) => m.id), ['agent', 'plain'])
  assert.equal(models[0]!.inputUsdPerMillion, 1)
  assert.equal(models[0]!.outputUsdPerMillion, 4)
  assert.deepEqual(models[0]!.peers.map((p) => [p.peerId, p.name, p.toolUse]), [['cc', null, false], ['bb', 'Beta', true]])
  assert.equal(models[1]!.toolUse, false)
})

test('the Web and Files switches leave their tools out', async () => {
  const all = chatTools({ sandboxDir: await sandbox(), allowShell: true })
  assert.deepEqual(Object.keys(all).sort(), ['list_files', 'read_file', 'run_command', 'web_fetch', 'web_search', 'write_file'])
  const noWeb = chatTools({ sandboxDir: await sandbox(), allowShell: false, web: false })
  assert.deepEqual(Object.keys(noWeb).sort(), ['list_files', 'read_file', 'write_file'])
  const none = chatTools({ sandboxDir: await sandbox(), allowShell: false, web: false, files: false })
  assert.deepEqual(Object.keys(none), [])
})

test('the system prompt only mentions the tools the chat has', async () => {
  const web = systemPrompt(chatTools({ sandboxDir: await sandbox(), allowShell: false, files: false }))
  assert.match(web, /Search and read the web/)
  assert.doesNotMatch(web, /scratch directory/)
  assert.match(systemPrompt({}), /no tools/)
})
