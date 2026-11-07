// Run by the Dockerfile after `npm ci`: refuses to build an image from a lock whose code would
// fail buyers' checks or weaken what they rely on.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const fail = (message) => {
  console.error(message)
  process.exit(1)
}
const modules = 'node_modules'

// The verifier must be the version this CLI pins (the CLI refuses any other), and must bind its
// quote to the buyer's connection, send the dstack event log and app compose, and attest on Google
// Confidential Space (launch.mjs also loads its seller config rules and state location check).
const verifier = join(modules, '@antseed/antseed-verifier')
const verifierFiles = ['dist/dstack-app-compose.js', 'dist/confidential-space.js', 'dist/seller-config-rules.js', 'dist/collect/unix-http.js']
if (!(await import(`./${verifier}/dist/shared.js`)).CHANNEL_BINDING_HEADER || !verifierFiles.every((f) => existsSync(join(verifier, f)))
  || !(await import(`./${verifier}/dist/confidential-space.js`)).parseStateLocation) {
  fail('The locked verifier cannot bind attestations to the buyer connection; run update-lock.mjs with a CLI release that pins one that can.')
}
const { TRUSTED_VERIFIER_PLUGINS } = await import(`./${modules}/@antseed/cli/dist/plugins/registry.js`)
const pinned = TRUSTED_VERIFIER_PLUGINS.find((p) => p.name === 'antseed-verifier')?.version
const installed = JSON.parse(readFileSync(join(verifier, 'package.json'), 'utf8')).version
if (pinned !== installed) fail(`verifier ${installed} installed, CLI pins ${pinned}`)

// Every copy of these packages must keep a buyer's request on the measured upstreams and its
// content out of the seller's logs and databases, which the operator may read:
//   - provider-core refuses upstream redirects (they would resend the request elsewhere) and never
//     logs a stream's content;
//   - buyer-core has the content-free mode the image turns on (ANTSEED_CONTENT_FREE_LOGS).
const copies = { 'provider-core': [], 'buyer-core': [] }
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(dir, entry.name)
    for (const name of Object.keys(copies)) if (path.endsWith(join('@antseed', name))) copies[name].push(path)
    walk(path)
  }
}
walk(modules)
for (const [name, paths] of Object.entries(copies)) if (paths.length === 0) fail(`no @antseed/${name} installed`)
for (const core of copies['provider-core']) {
  const relay = readFileSync(join(core, 'dist/http-relay.js'), 'utf8')
  if (!relay.includes("this._config.redirect ?? 'error'")) {
    fail(`${core} follows upstream redirects; run update-lock.mjs with releases that refuse them.`)
  }
  if (relay.includes('debugChunks')) fail(`${core} logs short streams' content; run update-lock.mjs with a release that doesn't.`)
}
for (const core of copies['buyer-core']) {
  if (!readFileSync(join(core, 'dist/debug.js'), 'utf8').includes('ANTSEED_CONTENT_FREE_LOGS')) {
    fail(`${core} has no content-free logging; run update-lock.mjs with a release that has it.`)
  }
}
