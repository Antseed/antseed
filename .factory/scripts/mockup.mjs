#!/usr/bin/env node
// Generate UI mockups through the AntSeed buyer (/v1/images/generations, or /v1/images/edits from a screenshot).
//
//   node .factory/scripts/mockup.mjs --out .factory/tasks/<slug>/design --name variant-a \
//     --prompt-file .factory/tasks/<slug>/design/variant-a.prompt.md [--from current.png] \
//     [--model gpt-image-2.5-flare] [--size 1536x1024] [--max-usd 0.25]
//
// Picks the cheapest peer for the model whose reputation is at least 60 (and, with --from, one that
// accepts an image input), pins the request to it, writes <out>/<name>.png, and appends
// {name, model, peer, usd, seconds, from, prompt_file} to <out>/images.jsonl. Refuses a peer whose
// per-image price is above --max-usd, and stops once <out>/images.jsonl reaches --budget-images
// (default 8). Every model, peer and price comes from the buyer's GET /v1/models.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const BUYER = process.env.ANTSEED_BUYER_URL ?? 'http://localhost:8377'
const DEFAULT_MODEL = 'gpt-image-2.5-flare'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index > 0 && process.argv[index + 1] !== undefined) return process.argv[index + 1]
  if (fallback === undefined) throw new Error(`missing --${name}`)
  return fallback
}

const out = resolve(arg('out'))
const name = arg('name').replace(/[^a-z0-9-]+/gi, '-')
const promptFile = resolve(arg('prompt-file'))
const from = arg('from', '')
const model = arg('model', DEFAULT_MODEL)
const size = arg('size', '1536x1024')
const maxUsd = Number(arg('max-usd', '0.25'))
const budgetImages = Number(arg('budget-images', '8'))
const prompt = readFileSync(promptFile, 'utf8').trim()
mkdirSync(out, { recursive: true })
const ledger = join(out, 'images.jsonl')
const used = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length : 0
if (used >= budgetImages) throw new Error(`image budget reached: ${used} of ${budgetImages} in ${ledger}`)

const catalog = await (await fetch(`${BUYER}/v1/models`)).json()
const sameId = (id) => id.replace(/\./g, '-') === model.replace(/\./g, '-')
const entry = catalog.data?.find((candidate) => sameId(candidate.id))
if (!entry) throw new Error(`model ${model} is not on the network (GET ${BUYER}/v1/models)`)
const peers = (entry.peers ?? [])
  .filter((peer) => (peer.effectiveReputationScore ?? 0) >= 60)
  .filter((peer) => !from || (peer.capabilities?.inputs ?? []).includes('image'))
  .filter((peer) => typeof peer.minImageUsdPerImage === 'number')
  .sort((left, right) => left.minImageUsdPerImage - right.minImageUsdPerImage)
if (!peers.length) throw new Error(`no peer with reputation >= 60${from ? ' that accepts an image input' : ''} serves ${model}`)
const [peer] = peers
if (peer.minImageUsdPerImage > maxUsd) throw new Error(`cheapest peer ${peer.displayName} charges $${peer.minImageUsdPerImage}, above --max-usd ${maxUsd}`)

const headers = { authorization: 'Bearer antseed', 'x-antseed-pin-peer': peer.peerId }
const started = Date.now()
let response
if (from) {
  const form = new FormData()
  form.append('model', entry.id)
  form.append('prompt', prompt)
  form.append('size', 'auto')
  form.append('n', '1')
  form.append('image', new Blob([readFileSync(resolve(from))], { type: 'image/png' }), basename(from))
  response = await fetch(`${BUYER}/v1/images/edits`, { method: 'POST', headers, body: form })
} else {
  response = await fetch(`${BUYER}/v1/images/generations`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ model: entry.id, prompt, size, n: 1 }),
  })
}
const body = await response.json().catch(() => ({}))
const image = body.data?.[0]
if (!response.ok || !image) throw new Error(`${model} via ${peer.displayName} failed (HTTP ${response.status}): ${JSON.stringify(body).slice(0, 400)}`)
const bytes = image.b64_json ? Buffer.from(image.b64_json, 'base64') : Buffer.from(await (await fetch(image.url)).arrayBuffer())
const file = join(out, `${name}.png`)
writeFileSync(file, bytes)
const record = {
  name, file, model: entry.id, peer: peer.displayName, peer_id: peer.peerId, usd: peer.minImageUsdPerImage,
  seconds: Math.round((Date.now() - started) / 1000), from: from || null, prompt_file: promptFile, at: new Date().toISOString(),
}
appendFileSync(ledger, `${JSON.stringify(record)}\n`)
console.log(JSON.stringify(record))
