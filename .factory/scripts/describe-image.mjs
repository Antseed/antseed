#!/usr/bin/env node
// Ask a vision model on GesundAI to look at one or more images (a mockup, a screenshot, or both side by side).
//
//   node .factory/scripts/describe-image.mjs --question "Does the screenshot match the mockup?" a.png [b.png ...]
//
// Prints the model's answer. Uses the buyer at ANTSEED_BUYER_URL (default http://localhost:8377), pinned to GesundAI.
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

const BUYER = process.env.ANTSEED_BUYER_URL ?? 'http://localhost:8377'
const GESUNDAI = '983e9de990b9ac8d36d373db5d0b49a4d7f7d826'
const args = process.argv.slice(2)
let question = 'Describe this UI in 5 short bullets: layout, legible text (quote it), visual quality, garbled or misspelled text.'
let model = 'claude-opus-5'
const files = []
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--question') question = args[++index]
  else if (args[index] === '--model') model = args[++index]
  else files.push(args[index])
}
if (!files.length) throw new Error('usage: describe-image.mjs [--question text] [--model id] image...')
const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
const content = files.map((file) => ({
  type: 'image_url',
  image_url: { url: `data:${mime[extname(file).toLowerCase()] ?? 'image/png'};base64,${readFileSync(file).toString('base64')}` },
}))
content.push({ type: 'text', text: `${files.length > 1 ? `Images in order: ${files.join(', ')}.\n` : ''}${question}` })
const response = await fetch(`${BUYER}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer antseed', 'x-antseed-pin-peer': GESUNDAI },
  body: JSON.stringify({ model, max_tokens: 1500, messages: [{ role: 'user', content }] }),
})
const body = await response.json().catch(() => ({}))
if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 400)}`)
const answer = body.choices?.[0]?.message?.content
if (!answer) throw new Error(`${model} returned no answer: ${JSON.stringify(body).slice(0, 300)}`)
console.log(answer)
