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
// quote to the buyer's connection and send the dstack event log and app compose.
const verifier = join(modules, '@antseed/antseed-verifier')
if (!(await import(`./${verifier}/dist/shared.js`)).CHANNEL_BINDING_HEADER || !existsSync(join(verifier, 'dist/dstack-app-compose.js'))) {
  fail('The locked verifier cannot bind attestations to the buyer connection; run update-lock.mjs with a CLI release that pins one that can.')
}
const { TRUSTED_VERIFIER_PLUGINS } = await import(`./${modules}/@antseed/cli/dist/plugins/registry.js`)
const pinned = TRUSTED_VERIFIER_PLUGINS.find((p) => p.name === 'antseed-verifier')?.version
const installed = JSON.parse(readFileSync(join(verifier, 'package.json'), 'utf8')).version
if (pinned !== installed) fail(`verifier ${installed} installed, CLI pins ${pinned}`)

// Every provider-core copy must refuse upstream redirects, which would resend the buyer's
// request to a destination the measured config does not name.
const cores = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(dir, entry.name)
    if (path.endsWith(join('@antseed', 'provider-core'))) cores.push(path)
    walk(path)
  }
}
walk(modules)
if (cores.length === 0) fail('no @antseed/provider-core installed')
for (const core of cores) {
  if (!readFileSync(join(core, 'dist/http-relay.js'), 'utf8').includes("this._config.redirect ?? 'error'")) {
    fail(`${core} follows upstream redirects; run update-lock.mjs with releases that refuse them.`)
  }
}
