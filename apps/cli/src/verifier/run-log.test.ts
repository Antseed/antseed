import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import {
  bundleVerifierLogs,
  createLogRedactor,
  listVerifierLogs,
  redactedConfig,
  sensitiveValues,
  startVerifierRunLog,
} from './run-log.js'

const redact = createLogRedactor([])

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'verifier-log-'))
}

function streams() {
  return { stdout: new PassThrough(), stderr: new PassThrough() }
}

test('a log keeps no secret: env values, config values, keys, tokens and RPC URLs', () => {
  const values = sensitiveValues(
    { OPENROUTER_API_KEY: 'plain-env-value-1234', ANTSEED_KEYSTORE_PASSWORD: 'hunter2hunter2', HOME: '/Users/someone', PRIVATE_KEY: '0xabcdefabcdef1234' },
    { verifier: { referenceEndpoint: { apiKey: 'config-value-5678' }, evidenceDir: '/tmp/evidence' } },
  )
  const line = createLogRedactor(values)([
    'plain-env-value-1234 hunter2hunter2 config-value-5678 abcdefabcdef1234',
    'Authorization: Bearer abc.def-ghi',
    'sk-or-v1-0123456789abcdef0123',
    'password=opensesame apiKey: "literal"',
    'https://base-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWx/more',
    'https://rpc.example/?apikey=abc',
    'https://user:pass@rpc.example/path',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P',
    '--private-key 0x1234',
  ].join(' | '))
  for (const secret of ['plain-env', 'hunter2', 'config-value', 'abcdefabcdef', 'abc.def', 'sk-or', 'opensesame', 'literal', 'AbCdEf', 'apikey=abc', 'user:pass', 'eyJhbG', '0x1234']) {
    assert.equal(line.includes(secret), false, secret)
  }
})

test('redaction leaves what we need to read a log: hashes, paths, public URLs and token counts', () => {
  const hash = `0x${'ab'.repeat(32)}`
  const line = `audit ${hash} https://openrouter.ai/api/v1/chat/completions inputTokens: 123 token: limit reached`
  assert.equal(redact(line), line)
})

test('a run log records each line with its time, stream and command, and leaves out redraws and colour', async () => {
  const dir = await tempDir()
  const io = streams()
  const log = startVerifierRunLog({
    dir,
    command: 'run',
    argv: ['verifier', 'run'],
    version: '1.2.3',
    redact,
    pid: 42,
    streams: io,
    now: () => new Date('2026-11-06T12:00:00.000Z'),
  })
  io.stdout.write('\x1b[32mone\x1b[0m\n')
  io.stdout.write('par')
  io.stdout.write('tial\n')
  io.stdout.write('\x1b[3A')
  io.stdout.write('\r\x1b[2Kgrok-4.7 [███] 1/12\n')
  io.stderr.write('warned\n')
  log.close(1)
  const text = await readFile(join(dir, 'verifier-2026-11-06.log'), 'utf8')
  assert.match(text, /^2026-11-06T12:00:00\.000Z \[42 run\] started: antseed verifier run \(cli 1\.2\.3/)
  assert.match(text, /\[42 run\] one\n/)
  assert.match(text, /\[42 run\] partial\n/)
  assert.match(text, /\[42 run\] stderr warned\n/)
  assert.match(text, /\[42 run\] finished: exit 1 after 0s\n$/)
  assert.equal(text.includes('grok-4.7'), false)
  assert.equal(text.includes('\x1b'), false)
})

test('terminal output is untouched, and closing a log stops copying', async () => {
  const dir = await tempDir()
  const io = streams()
  const seen: string[] = []
  io.stdout.on('data', (chunk) => seen.push(String(chunk)))
  const log = startVerifierRunLog({ dir, command: 'run', argv: [], version: '1', redact, streams: io })
  io.stdout.write('\x1b[32mcolour\x1b[0m\n')
  log.close(0)
  log.close(0)
  io.stdout.write('later line\n')
  assert.deepEqual(seen, ['\x1b[32mcolour\x1b[0m\n', 'later line\n'])
  const text = await readFile(log.path(), 'utf8')
  assert.equal(text.includes('later line'), false)
  assert.equal(text.split('finished:').length, 2)
})

test('a failing log never reaches the command', async () => {
  const dir = await tempDir()
  const io = streams()
  let date = new Date('2026-11-06T00:00:00.000Z')
  const log = startVerifierRunLog({ dir, command: 'run', argv: [], version: '1', redact, streams: io, now: () => date })
  await mkdir(join(dir, 'verifier-2026-11-07.log'))
  date = new Date('2026-11-07T00:00:00.000Z')
  assert.doesNotThrow(() => io.stdout.write('line\n'))
  assert.doesNotThrow(() => io.stdout.write('another\n'))
  assert.doesNotThrow(() => log.close(0))
})

test('logs older than the retention are removed, other files are not', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'verifier-2026-10-01.log'), 'old')
  await writeFile(join(dir, 'verifier-2026-11-05.log'), 'recent')
  await writeFile(join(dir, 'notes.txt'), 'mine')
  const log = startVerifierRunLog({
    dir, command: 'run', argv: [], version: '1', redact, streams: streams(), now: () => new Date('2026-11-06T00:00:00.000Z'),
  })
  log.close(0)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual((await readdir(dir)).sort(), ['notes.txt', 'verifier-2026-11-05.log', 'verifier-2026-11-06.log'])
})

test('a bundle holds the newest days, oldest first, and redacts them again', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'verifier-2026-11-04.log'), 'dropped\n')
  await writeFile(join(dir, 'verifier-2026-11-05.log'), 'first\n')
  await writeFile(join(dir, 'verifier-2026-11-06.log'), 'second late-secret-value\n')
  const outPath = join(dir, 'bundle.log.gz')
  const result = await bundleVerifierLogs({
    files: await listVerifierLogs(dir),
    days: 2,
    header: '{"cli":"1"}',
    redact: createLogRedactor(['late-secret-value']),
    outPath,
  })
  assert.equal(result.files, 2)
  const text = gunzipSync(await readFile(outPath)).toString('utf8')
  assert.ok(text.startsWith('{"cli":"1"}\n'))
  assert.equal(text.includes('dropped'), false)
  assert.equal(text.includes('late-secret-value'), false)
  assert.ok(text.indexOf('first') < text.indexOf('second'))
})

test('a bundled config hides sensitive settings and keeps the ones that explain a run', () => {
  const config = redactedConfig({
    referenceMaxConcurrentRequests: 12,
    keystore: '/keys/auditor',
    referenceEndpoint: { apiKey: 'value', baseUrl: 'https://openrouter.ai/api/v1' },
    rpcUrl: 'https://rpc.example',
  }, redact) as Record<string, unknown>
  assert.deepEqual(config, {
    referenceMaxConcurrentRequests: 12,
    keystore: '<redacted>',
    referenceEndpoint: { apiKey: '<redacted>', baseUrl: 'https://openrouter.ai/api/v1' },
    rpcUrl: '<redacted>',
  })
})
