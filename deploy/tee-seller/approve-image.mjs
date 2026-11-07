#!/usr/bin/env node
// Adds a published TEE seller image to the verifier's approved images, so buyers accept a seller
// node running it once the verifier is released. The "Publish TEE seller image" workflow runs it
// and opens the pull request.
//
//   node deploy/tee-seller/approve-image.mjs <cli version> <sha256:digest>
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [version, digest] = process.argv.slice(2)
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) {
  console.error('usage: node deploy/tee-seller/approve-image.mjs <cli version> <sha256:digest>')
  process.exit(1)
}

const file = join(dirname(fileURLToPath(import.meta.url)), '../../packages/antseed-verifier/src/approved-seller-images.ts')
const source = readFileSync(file, 'utf8')
if (source.includes(digest)) {
  console.log(`${digest} is already approved`)
  process.exit(0)
}
const open = 'export const APPROVED_SELLER_IMAGES: readonly ApprovedSellerImage[] = [\n'
const at = source.indexOf(open)
const end = source.indexOf('\n]', at)
if (at < 0 || end < 0) throw new Error(`no APPROVED_SELLER_IMAGES list in ${file}`)
// Append as the list's last line, before its closing bracket.
const entry = `  { version: '${version}', digest: '${digest}' },\n`
writeFileSync(file, source.slice(0, end + 1) + entry + source.slice(end + 1))
console.log(`Approved TEE seller image ${version} ${digest}`)
