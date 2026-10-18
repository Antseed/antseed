#!/usr/bin/env node
// Read-only: answers "is this worktree's sandbox worth driving?". Starts, stops and writes nothing.
// Usage: .claude/skills/verify-antseed/scripts/doctor.mjs [--slot NAME]
// Exit codes: 0 ready, 1 at least one FAIL line, 2 not run from an AntSeed worktree.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repo = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
if (!repo || !existsSync(join(repo, 'e2e/sandbox/cli.mjs'))) {
  console.log('FAIL not inside an AntSeed worktree with e2e/sandbox (run from the worktree)');
  process.exit(2);
}
const slotIndex = process.argv.indexOf('--slot');
const slot = slotIndex > 0 ? process.argv[slotIndex + 1] : undefined;
let failed = false;
const ok = (message) => console.log(`OK   ${message}`);
const warn = (message) => console.log(`WARN ${message}`);
const fail = (message) => { failed = true; console.log(`FAIL ${message}`); };
const which = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).stdout.trim();

const wanted = readFileSync(join(repo, '.nvmrc'), 'utf8').trim().replace(/^v/, '').split('.')[0];
const major = process.versions.node.split('.')[0];
if (major === wanted) ok(`node ${process.version} (${process.execPath})`);
else fail(`node ${process.version} at ${process.execPath}; sandbox up needs ${wanted}.x (macOS: Volta; Linux: /usr/local/bin or nvm use)`);

for (const bin of ['pnpm', 'anvil']) {
  if (which(bin)) ok(`${bin} on PATH`);
  else fail(`${bin} missing from PATH (Foundry: export PATH=$HOME/.foundry/bin:$PATH)`);
}
if (which('forge') && existsSync(join(repo, 'packages/contracts/lib/forge-std/src'))) ok('--chain local ready (forge + forge-std)');
else fail('--chain local needs forge and packages/contracts/lib/forge-std (git submodule update --init packages/contracts/lib/forge-std)');

const envLocal = join(repo, '.env.local');
const hasRpc = existsSync(envLocal) && /^BASE_MAINNET_RPC_URL=./m.test(readFileSync(envLocal, 'utf8'));
if (hasRpc || process.env.BASE_MAINNET_RPC_URL) ok('--chain fork available (BASE_MAINNET_RPC_URL set; value not shown)');
else warn('--chain fork unavailable: no BASE_MAINNET_RPC_URL in .env.local or the shell; use --chain local');

const newest = (dir, skip = () => false) => {
  let latest = 0;
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(child); }
      else if (!skip(child)) latest = Math.max(latest, statSync(child).mtimeMs);
    }
  };
  if (existsSync(dir)) walk(dir);
  return latest;
};
const isTest = (path) => /\.test\.[cm]?[jt]sx?$|\/__tests__\//.test(path);
const loaded = ['packages/protocol', 'packages/api-adapter', 'packages/buyer-core', 'packages/node', 'packages/provider-core', 'packages/router-core', 'plugins/provider-openai', 'plugins/router-local', 'apps/cli'];
const stale = [];
for (const pkg of loaded) {
  const dist = newest(join(repo, pkg, 'dist'));
  if (!dist) fail(`${pkg}/dist missing: pnpm run build`);
  else if (newest(join(repo, pkg, 'src'), isTest) > dist) stale.push(pkg);
}
if (stale.length) fail(`src newer than dist (the sandbox loads dist): ${stale.join(', ')}. Rebuild: pnpm run build, or pnpm --filter <pkg> run build in dependency order`);
else ok('sandbox packages built (dist newer than src)');

const desktopBuild = 'pnpm --filter @antseed/desktop run build:main && pnpm --filter @antseed/desktop run build:renderer';
const desktopParts = [['main', 'apps/desktop/src/main', 'apps/desktop/dist/main/main.js'], ['renderer', 'apps/desktop/src/renderer', 'apps/desktop/dist/renderer/index.html']];
const missing = desktopParts.filter(([, , built]) => !existsSync(join(repo, built)));
const staleDesktop = desktopParts.filter(([, source, built]) => existsSync(join(repo, built)) && newest(join(repo, source), isTest) > statSync(join(repo, built)).mtimeMs);
if (missing.length) warn(`desktop ${missing.map(([part]) => part).join(' and ')} not built: desktop scenarios need ${desktopBuild}`);
else if (staleDesktop.length) warn(`desktop ${staleDesktop.map(([part]) => part).join(' and ')} src newer than dist: run ${desktopBuild} before desktop scenarios`);
else ok('desktop built (main and renderer)');
if (process.platform === 'linux' && !process.env.DISPLAY) {
  if (which('xvfb-run')) ok('no DISPLAY: wrap desktop scenarios in xvfb-run -a');
  else warn('no DISPLAY and no xvfb-run: desktop scenarios cannot open a window (apt-get install xvfb)');
}

const status = spawnSync(process.execPath, [join(repo, 'e2e/sandbox/cli.mjs'), 'status', '--json', ...(slot ? ['--slot', slot] : [])], { cwd: repo, encoding: 'utf8' });
let live = null;
try { live = JSON.parse(status.stdout); } catch { fail(`pnpm sandbox status --json failed: ${(status.stderr || status.stdout).trim()}`); }
if (live && !live.running) ok(`sandbox ${live.name} not running${live.lock === 'stale' ? ' (stale lock; the next up cleans it)' : ''}; pnpm sandbox run starts one`);
if (live?.running) {
  const m = live.manifest;
  const sellers = live.live.sellers.map((seller) => `${seller.id}:${seller.online ? 'online' : 'offline'}`).join(' ');
  ok(`sandbox ${m.name} running: chain ${m.target}, upstream ${m.upstream}, proxy ${m.proxyUrl}, block ${live.live.chainBlock}, sellers ${sellers}, buyer sees ${live.live.peersSeenByBuyer.length} peer(s), ${live.live.channels.length} open channel(s)`);
  if (m.upstream === 'live') warn('upstream is live: runs spend real provider money');
  if (live.live.peersSeenByBuyer.length === 0) fail('the buyer sees no sellers: pnpm sandbox logs supervisor, then pnpm sandbox down');
}
process.exit(failed ? 1 : 0);
