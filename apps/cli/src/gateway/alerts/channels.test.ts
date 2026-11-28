import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import http from 'node:http'
import { test } from 'node:test'
import type { AlertDestinationRecord } from '../store.js'
import { createAlertTransport, isForbiddenWebhookAddress, signWebhook, webhookBody, SMTP_FROM_ENV, SMTP_URL_ENV, WEBHOOK_SIGNATURE_HEADER } from './channels.js'
import { testEvent } from './events.js'

const NOW = Date.UTC(2026, 10, 10, 12)
const event = testEvent({ id: 'ws_default', name: 'Default' }, NOW)

function dest(overrides: Partial<AlertDestinationRecord>): AlertDestinationRecord {
  return {
    id: 'ad_1', workspaceId: 'ws_default', kind: 'webhook', label: 'Ops', target: 'https://hooks.example.test/x', secret: null,
    events: ['balance'], enabled: true, createdAt: NOW, lastSentAt: null, lastError: null, ...overrides,
  }
}

test('webhooks are signed over the timestamp and the exact body', async () => {
  const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = []
  let status = 200
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(status).end('ok')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = (server.address() as { port: number }).port
    const transport = createAlertTransport({ now: () => NOW })
    await transport.send(dest({ target: `http://127.0.0.1:${port}/hook`, secret: 'whsec_test' }), event)
    const [delivery] = received
    assert.ok(delivery)
    assert.equal(delivery.body, webhookBody(event))
    assert.equal(delivery.headers['x-antseed-event'], 'test')
    assert.equal(delivery.headers['x-antseed-delivery'], event.id)
    const signature = String(delivery.headers[WEBHOOK_SIGNATURE_HEADER])
    const t = Math.floor(NOW / 1000)
    assert.equal(signature, `t=${t},v1=${createHmac('sha256', 'whsec_test').update(`${t}.${delivery.body}`).digest('hex')}`)
    assert.equal(signature, signWebhook('whsec_test', delivery.body, NOW))
    const parsed = JSON.parse(delivery.body) as Record<string, unknown>
    assert.equal(parsed['type'], 'test')
    assert.deepEqual(parsed['workspace'], { id: 'ws_default', name: 'Default' })

    status = 500
    await assert.rejects(transport.send(dest({ target: `http://127.0.0.1:${port}/hook` }), event), /HTTP 500/)
    status = 302
    await assert.rejects(transport.send(dest({ target: `http://127.0.0.1:${port}/hook` }), event), /HTTP 302/, 'redirects are not followed')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('webhooks to link-local and cloud metadata addresses are refused', async () => {
  assert.equal(isForbiddenWebhookAddress('169.254.169.254'), true)
  assert.equal(isForbiddenWebhookAddress('::ffff:169.254.169.254'), true)
  assert.equal(isForbiddenWebhookAddress('::ffff:a9fe:a9fe'), true, 'IPv4-mapped in hex')
  assert.equal(isForbiddenWebhookAddress('0:0:0:0:0:ffff:a9fe:a9fe'), true, 'IPv4-mapped, uncompressed')
  assert.equal(isForbiddenWebhookAddress('fe80::1'), true)
  assert.equal(isForbiddenWebhookAddress('fe80::1%eth0'), true)
  assert.equal(isForbiddenWebhookAddress('FD00:EC2:0:0:0:0:0:254'), true)
  assert.equal(isForbiddenWebhookAddress('127.0.0.1'), false, 'a top-up script next to the gateway is allowed')
  assert.equal(isForbiddenWebhookAddress('::ffff:7f00:1'), false)
  assert.equal(isForbiddenWebhookAddress('10.0.0.5'), false)
  const transport = createAlertTransport({ lookup: async () => ['169.254.169.254'] })
  await assert.rejects(transport.send(dest({ target: 'http://metadata.example.test/' }), event), /not allowed/)
  await assert.rejects(transport.send(dest({ target: 'http://169.254.169.254/latest' }), event), /not allowed/)
  await assert.rejects(transport.send(dest({ target: 'http://[::ffff:a9fe:a9fe]/latest' }), event), /not allowed/)
})

test('a webhook connects only to the address its one lookup checked', async () => {
  let hits = 0
  const server = http.createServer((req, res) => {
    hits += 1
    assert.equal(req.headers.host?.startsWith('hooks.example.test:'), true, 'the URL host is kept')
    req.resume()
    req.on('end', () => res.writeHead(204).end())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = (server.address() as { port: number }).port
    const target = `http://hooks.example.test:${port}/hook`
    const answers = [['127.0.0.1'], ['169.254.169.254']]
    const lookups: string[] = []
    const transport = createAlertTransport({ lookup: async (host) => { lookups.push(host); return answers.shift() ?? [] } })
    await transport.send(dest({ target }), event)
    assert.deepEqual(lookups, ['hooks.example.test'], 'one lookup, and the connection used its answer')
    assert.equal(hits, 1)
    // The next answer changed to a metadata address: the connection is refused, not made.
    await assert.rejects(transport.send(dest({ target }), event), /not allowed/)
    const mixed = createAlertTransport({ lookup: async () => ['127.0.0.1', '169.254.169.254'] })
    await assert.rejects(mixed.send(dest({ target }), event), /not allowed/)
    assert.equal(hits, 1)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('telegram sends through the workspace bot and never leaks its token in errors', async () => {
  const token = '123456:AAbbccddeeffgghhiijjkkll'
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  let answer: Response = Response.json({ ok: true })
  const transport = createAlertTransport({
    fetch: (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return answer
    }) as typeof fetch,
  })
  await transport.send(dest({ kind: 'telegram', target: '-1001234', secret: token }), event)
  assert.equal(calls[0]!.url, `https://api.telegram.org/bot${token}/sendMessage`)
  assert.equal(calls[0]!.body['chat_id'], '-1001234')
  assert.match(String(calls[0]!.body['text']), /test alert/)

  answer = Response.json({ ok: false, description: 'Forbidden: bot was kicked' }, { status: 403 })
  await assert.rejects(transport.send(dest({ kind: 'telegram', target: '-1001234', secret: token }), event), /bot was kicked/)

  const failing = createAlertTransport({ fetch: (async (url: string | URL) => { throw new Error(`connect failed ${String(url)}`) }) as typeof fetch })
  await assert.rejects(failing.send(dest({ kind: 'telegram', target: '-1001234', secret: token }), event), (error: Error) => {
    assert.equal(error.message.includes(token), false)
    assert.match(error.message, /<token>/)
    return true
  })
})

test('email needs the host SMTP settings and goes to every address', async () => {
  const mails: Array<{ from: string; to: string[]; subject: string; text: string }> = []
  const unset = createAlertTransport({ env: {}, sendMail: async (mail) => { mails.push(mail) } })
  assert.equal(unset.emailConfigured(), false)
  await assert.rejects(unset.send(dest({ kind: 'email', target: 'ops@example.com' }), event), /not set up/)

  const transport = createAlertTransport({
    env: { [SMTP_URL_ENV]: 'smtp://user:pass@smtp.example.test:587', [SMTP_FROM_ENV]: 'Gateway <alerts@example.com>' },
    sendMail: async (mail) => { mails.push(mail) },
  })
  assert.equal(transport.emailConfigured(), true)
  await transport.send(dest({ kind: 'email', target: 'ops@example.com, cfo@example.com' }), event)
  assert.deepEqual(mails[0]!.to, ['ops@example.com', 'cfo@example.com'])
  assert.equal(mails[0]!.from, 'Gateway <alerts@example.com>')
  assert.equal(mails[0]!.subject, '[Antseed] Default: test alert')
})
