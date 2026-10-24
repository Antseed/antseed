#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveInstancePorts } from '../../apps/desktop/scripts/dev-instance-config.mjs';
import { legacyCacheHome, sharedCacheHome } from './lib/cache.mjs';
import { loadSourceConfig, resolveConfigSource } from './lib/config.mjs';
import { loadControlClient } from './lib/control.mjs';
import { FORBIDDEN_PORTS, isolatedEnv, parseEnvFile, resolveForkUrl, resolveLiveKeys } from './lib/env.mjs';
import { inspectLock, isOwnedProcessAlive, killOwned } from './lib/lock.mjs';
import { readJson, saveJson, validateManifest } from './lib/manifest.mjs';
import { HELP, parseArgs } from './lib/options.mjs';
import { sandboxName, sandboxPaths, sandboxRoot, worktreeRoot } from './lib/paths.mjs';
import { createSandboxApi } from './lib/sb.mjs';
import { writeHtmlReport } from './lib/report-html.mjs';
import { serveReports } from './lib/report-server.mjs';
import { createMainnetApi, mainnetReader } from './lib/mainnet-run.mjs';
import { MAINNET_PROFILE, prepareMainnetProfile, profileDesktopEnv } from './lib/mainnet.mjs';
import { findNoVncDir, funnelEnabled, parseTailscaleStatus } from './lib/share.mjs';
import { assertScenarioSupported, chooseTarget, normalizeTopology, topologyFingerprint, validateScenarioModule } from './lib/topology.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const say = (message) => console.log(`[sandbox] ${message}`);

function context(options) {
  const worktree = worktreeRoot();
  const root = sandboxRoot();
  const name = sandboxName(worktree, options.slot);
  return { worktree, root, name, paths: sandboxPaths(root, name) };
}

async function runningState(paths) {
  const lock = await inspectLock(paths.lock);
  const manifest = await readJson(paths.manifest);
  return { lock, manifest, running: lock.state === 'held' && manifest?.running === true };
}

function portOpen(port) {
  return new Promise((resolvePort) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolvePort(true); });
    socket.once('error', () => resolvePort(false));
    socket.setTimeout(1000, () => { socket.destroy(); resolvePort(false); });
  });
}

/** Kills only processes recorded in our manifest whose start time still matches. */
async function cleanupStale(paths, manifest) {
  const entries = [manifest?.supervisor, manifest?.anvil, ...(manifest?.sellers ?? []).map((seller) => seller.process)].filter(Boolean);
  const results = [];
  for (const entry of entries) results.push(`${entry.pid}:${await killOwned(entry, { graceMs: entry === manifest?.anvil ? 30_000 : 10_000 })}`);
  await rm(paths.lock, { force: true });
  await saveJson(paths.control, {}).catch(() => {});
  if (manifest) await saveJson(paths.manifest, { ...manifest, running: false, staleCleanedAt: new Date().toISOString() });
  return results;
}

async function scenarioModule(name) {
  const file = join(here, 'scenarios', `${name}.mjs`);
  if (!existsSync(file)) throw new Error(`No scenario ${name} (looked for ${file})`);
  return validateScenarioModule(await import(pathToFileURL(file).href), name);
}

function checkBuilt(target = 'fork') {
  const pinned = existsSync(join(repo, '.nvmrc')) ? readFileSync(join(repo, '.nvmrc'), 'utf8').trim().split('.')[0] : null;
  if (pinned && process.versions.node.split('.')[0] !== pinned) {
    throw new Error(`Node ${process.versions.node} does not match .nvmrc (${pinned}.x); native modules (better-sqlite3) would fail to load and disable buyer payments. Switch Node (volta/nvm) and retry`);
  }
  const required = ['packages/node/dist/index.js', 'apps/cli/dist/proxy/buyer-proxy.js', 'plugins/provider-openai/dist/index.js'];
  const missing = required.filter((file) => !existsSync(join(repo, file)));
  if (missing.length) throw new Error(`Build first (pnpm run build). Missing: ${missing.join(', ')}`);
  for (const command of target === 'local' ? ['anvil', 'forge'] : ['anvil']) {
    if (spawnSync(command, ['--version'], { stdio: 'ignore' }).status !== 0) throw new Error(`Install Foundry and put ${command} on PATH`);
  }
  if (target === 'local' && !existsSync(join(repo, 'packages/contracts/lib/forge-std/src/Script.sol'))) {
    throw new Error('Local chain needs forge-std: (cd packages/contracts && forge install foundry-rs/forge-std --no-git)');
  }
}

async function up(options, ctx, topologyOverride) {
  const { paths } = ctx;
  const target = options.chain ?? 'fork';
  const current = await runningState(paths);
  if (current.running) {
    if (options.chain && (current.manifest.target ?? 'fork') !== options.chain) {
      throw new Error(`Sandbox ${ctx.name} is running on chain ${current.manifest.target ?? 'fork'}; run pnpm sandbox down first or use --slot`);
    }
    say(`Sandbox ${ctx.name} is already running; reattaching`);
    return current.manifest;
  }
  if (current.lock.state === 'held') {
    throw new Error(`Sandbox ${ctx.name} is starting or stopping (pid ${current.lock.holder.pid}); wait, or run pnpm sandbox down --force`);
  }
  if (current.lock.state === 'stale' || current.manifest?.running || current.manifest?.starting) {
    say(`Cleaning up stale sandbox state: ${(await cleanupStale(paths, current.manifest)).join(', ') || 'nothing running'}`);
  }
  checkBuilt(target);
  if (target === 'local' && options.block !== undefined) throw new Error('--block only applies to --chain fork');
  const source = resolveConfigSource({ explicit: options.config, worktree: ctx.worktree });
  const config = await loadSourceConfig(source);
  const scenario = options.scenario ? await scenarioModule(options.scenario) : null;
  const topology = normalizeTopology(topologyOverride ?? scenario?.topology ?? {}, config.cleaned, { depositUsdc: options.depositUsdc, block: options.block });
  const upstream = options.live ? 'live' : 'mock';
  const liveKeys = [];
  let liveEnv = {};
  if (upstream === 'live') {
    const names = new Map();
    for (const seller of topology.sellers) {
      for (const [providerName, provider] of Object.entries(seller.providers)) {
        if (!provider.apiKeyEnv) throw new Error(`--live requires apiKeyEnv for provider ${providerName}`);
        names.set(provider.apiKeyEnv, [...(names.get(provider.apiKeyEnv) ?? []), providerName]);
      }
    }
    const envFile = options.envFile ? resolve(options.envFile) : join(ctx.worktree, '.antseed-sandbox.env');
    if (options.envFile && !existsSync(envFile)) throw new Error(`--env-file ${envFile} does not exist`);
    const fileValues = existsSync(envFile) ? parseEnvFile(await readFile(envFile, 'utf8')) : {};
    const resolved = resolveLiveKeys([...names.keys()], { fileValues });
    if (resolved.missing.length) {
      throw new Error(`--live requires ${resolved.missing.map((name) => `${name} (providers ${names.get(name).join(', ')})`).join(', ')}; export it or put it in ${envFile}`);
    }
    liveKeys.push(...names.keys());
    liveEnv = resolved.values;
    say(`Live keys: ${[...names].map(([name, providers]) => `${name} from ${resolved.sources[name]} -> ${providers.join(', ')}`).join('; ')}`);
  }
  for (const dir of [paths.dir, paths.config, paths.logs]) await mkdir(dir, { recursive: true, mode: 0o700 });
  await saveJson(join(paths.config, 'source.cleaned.json'), { origin: config.origin, path: config.path, hash: config.hash, dropped: config.dropped, config: config.cleaned });
  let forkUrl;
  if (target === 'fork') {
    const localEnv = join(ctx.worktree, '.env.local');
    const fork = resolveForkUrl({ fileValues: existsSync(localEnv) ? parseEnvFile(await readFile(localEnv, 'utf8')) : {}, envFile: localEnv });
    forkUrl = fork.url;
    say(`Fork RPC: BASE_MAINNET_RPC_URL from ${fork.source}`);
  } else {
    say('Local chain: plain Anvil + packages/contracts deployed from source (no fork, no RPC key)');
  }
  await saveJson(join(paths.config, 'plan.json'), {
    worktree: ctx.worktree, target, topology, upstream, liveKeys: [...new Set(liveKeys)], verbose: Boolean(options.verbose),
    configHash: config.hash, configOrigin: config.origin, cacheHome: sharedCacheHome(process.env, ctx.root), legacyCacheHome: legacyCacheHome(),
  });
  say(`Starting ${ctx.name} (chain: ${target}, config: ${config.origin}, upstream: ${upstream}, sellers: ${topology.sellers.map((seller) => seller.id).join(', ')})`);
  if (config.dropped.length) say(`Ignored config settings: ${config.dropped.join(', ')}`);
  const logPath = join(paths.logs, 'supervisor.log');
  const logOffset = existsSync(logPath) ? statSync(logPath).size : 0;
  const out = openSync(logPath, 'a');
  const env = isolatedEnv(process.env, paths.home, {
    ...(forkUrl ? { ANTSEED_SANDBOX_FORK_URL: forkUrl } : { ANTSEED_SANDBOX_TOOL_HOME: process.env.HOME }),
    ...liveEnv,
  });
  const child = spawn(process.execPath, [join(here, 'supervisor.mjs'), ctx.root, ctx.name], { cwd: repo, env, detached: true, stdio: ['ignore', out, out] });
  closeSync(out);
  child.unref();
  const deadline = Date.now() + Number(options.timeout ?? 600) * 1000;
  let offset = logOffset;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const text = await readFile(logPath, 'utf8').catch(() => '');
    if (text.length > offset) {
      process.stdout.write(text.slice(offset).split('\n').filter((line) => line.includes('[supervisor]')).map((line) => `  ${line.replace(/^\[supervisor\] \S+ /, '')}\n`).join(''));
      offset = text.length;
    }
    const manifest = await readJson(paths.manifest);
    if (manifest?.running && manifest.supervisor?.pid === child.pid) {
      validateManifest(manifest, { dir: paths.dir });
      return manifest;
    }
    if (child.exitCode !== null || (manifest?.startError && manifest.supervisor?.pid === child.pid)) {
      throw new Error(`Sandbox failed to start: ${manifest?.startError ?? 'supervisor exited'} (see ${logPath})`);
    }
    try { process.kill(child.pid, 0); } catch { throw new Error(`Sandbox supervisor exited during startup (see ${logPath})`); }
  }
  throw new Error(`Timed out waiting for the sandbox to start (see ${logPath}); run pnpm sandbox down to clean up`);
}

async function down(options, ctx) {
  const { paths } = ctx;
  await stopShare(ctx, { quiet: true });
  const state = await runningState(paths);
  if (state.lock.state === 'free' && !state.manifest?.running) {
    say(`Sandbox ${ctx.name} is not running`);
    return;
  }
  if (state.lock.state === 'held' && !options.force) {
    say('Settling channels and stopping (Anvil stays up until channels close)...');
    const control = await loadControlClient(paths.control).catch(() => null);
    if (!control) throw new Error('Sandbox is still starting; wait, or use pnpm sandbox down --force');
    await control.shutdown();
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline && isOwnedProcessAlive(state.lock.holder)) await new Promise((r) => setTimeout(r, 500));
    if (isOwnedProcessAlive(state.lock.holder)) throw new Error('Supervisor did not stop in 5 minutes; use pnpm sandbox down --force');
  } else {
    say(`Force-stopping owned processes: ${(await cleanupStale(paths, state.manifest)).join(', ') || 'none alive'}`);
  }
  const manifest = await readJson(paths.manifest);
  const ports = [manifest?.anvil?.port, manifest?.proxyPort, manifest?.bootstrap?.port, ...(manifest?.sellers ?? []).map((seller) => seller.signalingPort)].filter(Boolean);
  const open = [];
  for (const port of ports) if (await portOpen(port)) open.push(port);
  if (manifest?.shutdownErrors?.length) say(`Shutdown reported: ${manifest.shutdownErrors.join('; ')}`);
  if (manifest?.finalBalances) say(`Buyer deposit after close: available=${manifest.finalBalances.availableMicroUsdc} reserved=${manifest.finalBalances.reservedMicroUsdc}`);
  if (open.length) say(`Warning: ports still accepting connections: ${open.join(', ')} (another process may have taken them)`);
  say(`Sandbox ${ctx.name} stopped`);
}

function envExports(manifest) {
  return [
    `export ANTSEED_PROXY_URL=${manifest.proxyUrl}`,
    `export OPENAI_BASE_URL=${manifest.proxyUrl}/v1`,
    `export ANTSEED_SANDBOX_RPC_URL=${manifest.rpcUrl}`,
    `export ANTSEED_SANDBOX_NAME=${manifest.name}`,
  ].join('\n');
}

async function status(options, ctx) {
  const state = await runningState(ctx.paths);
  if (!state.running) {
    if (options.json) console.log(JSON.stringify({ name: ctx.name, running: false, lock: state.lock.state }, null, 2));
    else say(`Sandbox ${ctx.name} is not running${state.lock.state === 'stale' ? ' (stale lock; pnpm sandbox up will clean it up)' : ''}`);
    process.exitCode = options.json ? 0 : 3;
    return;
  }
  if (options.env) { console.log(envExports(state.manifest)); return; }
  const live = await (await loadControlClient(ctx.paths.control)).status();
  if (options.json) { console.log(JSON.stringify({ running: true, ...live }, null, 2)); return; }
  const m = live.manifest;
  const usdc = (micro) => `${(Number(micro) / 1e6).toFixed(6)} USDC`;
  console.log(`Sandbox   ${m.name}  (target ${m.target}, upstream ${m.upstream}, ${m.target === 'local' ? 'local chain 31337' : `fork block ${m.forkBlock}`}, chain block ${live.live.chainBlock})`);
  console.log(`State     ${ctx.paths.dir}`);
  console.log(`Proxy     ${m.proxyUrl}`);
  console.log(`RPC       ${m.rpcUrl}  (Anvil pid ${m.anvil.pid})`);
  console.log(`Bootstrap 127.0.0.1:${m.bootstrap.port}`);
  console.log(`Buyer     ${m.buyer.address}  deposit available ${usdc(live.live.buyer.availableMicroUsdc)}, reserved ${usdc(live.live.buyer.reservedMicroUsdc)}`);
  for (const seller of live.live.sellers) {
    const info = m.sellers.find((entry) => entry.id === seller.id);
    console.log(`Seller    ${seller.id.padEnd(10)} ${seller.online ? 'online ' : 'offline'} ${seller.peerId}  ${seller.address}  signaling ${info.signalingPort}  usdc ${usdc(seller.usdcMicro)}  models ${info.models.join(',')}`);
  }
  console.log(`Peers     buyer sees ${live.live.peersSeenByBuyer.length}: ${live.live.peersSeenByBuyer.join(', ') || 'none'}`);
  console.log(`Channels  ${live.live.channels.length} active`);
  console.log(`\n${envExports(m)}`);
}

async function runScenario(options, ctx) {
  const scenario = await scenarioModule(options.scenario);
  if (options.chain === 'mainnet' || (!options.chain && scenario.targets[0] === 'mainnet')) return runMainnetScenario(options, ctx, scenario);
  const before = await runningState(ctx.paths);
  const target = chooseTarget(scenario, { requested: options.chain, running: before.running ? (before.manifest.target ?? 'fork') : null });
  assertScenarioSupported(scenario, target);
  const live = before.running ? before.manifest.upstream === 'live' : Boolean(options.live);
  if (scenario.requires.includes('liveUpstream') && !live) {
    throw new Error(`Scenario ${scenario.name} needs a real upstream; ${before.running ? 'restart the sandbox with pnpm sandbox up --live' : 'rerun with --live'}`);
  }
  let manifest;
  let startedHere = false;
  if (before.running) {
    manifest = before.manifest;
    const source = await loadSourceConfig(resolveConfigSource({ explicit: options.config, worktree: ctx.worktree }));
    const wanted = topologyFingerprint(normalizeTopology(scenario.topology ?? {}, source.cleaned, {}));
    const running = topologyFingerprint(manifest.topology);
    if (wanted !== running) throw new Error(`Running sandbox topology (${running}) does not match scenario ${scenario.name} (${wanted}); run pnpm sandbox down first or use --slot`);
  } else {
    manifest = await up({ ...options, chain: target, scenario: scenario.name }, ctx);
    startedHere = true;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportDir = join(ctx.paths.reports, `${stamp}-${scenario.name}`);
  await mkdir(reportDir, { recursive: true, mode: 0o700 });
  const sdk = await import(join(repo, 'packages/node/dist/index.js'));
  const chain = sdk.getChainConfig(target === 'local' ? 'base-local' : 'base-mainnet');
  const control = await loadControlClient(ctx.paths.control);
  const sb = createSandboxApi({ manifest, control, eventsPath: join(reportDir, 'events.jsonl'), chain, strict: Boolean(options.strict), repo, reportDir, trace: Boolean(options.trace) });
  const report = {
    scenario: scenario.name, description: scenario.description, target, sandbox: manifest.name, result: 'running',
    startedAt: new Date().toISOString(), configHash: manifest.configHash, configOrigin: manifest.configOrigin, upstream: manifest.upstream,
    forkBlock: manifest.forkBlock, forkCache: manifest.forkCache, topology: manifest.topology,
    sellers: manifest.sellers.map(({ id, peerId, address }) => ({ id, peerId, address })), buyer: manifest.buyer,
  };
  say(`Running scenario ${scenario.name} against ${manifest.name}`);
  try {
    await scenario.run(sb);
    report.result = 'passed';
  } catch (error) {
    report.result = 'failed';
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    const summary = sb.summary();
    Object.assign(report, { finishedAt: new Date().toISOString(), checks: summary.checks, knownIssues: summary.knownIssues, strict: Boolean(options.strict), metrics: summary.metrics });
    await saveJson(join(reportDir, 'report.json'), report);
    await saveJson(join(reportDir, 'metrics.json'), summary.metrics);
    await sb.dispose();
    await writeHtmlReport(reportDir, report).catch((error) => say(`HTML report failed: ${error.message}`));
  }
  printReport(report, reportDir);
  if (startedHere && !options.keep) {
    try { await down({}, ctx); } catch (error) { say(`Teardown failed: ${error.message}`); process.exitCode = 1; }
  } else if (startedHere) say('Sandbox kept running (--keep); stop it with pnpm sandbox down');
}

async function localEnvValues(ctx) {
  const file = join(ctx.worktree, '.env.local');
  return { file, values: existsSync(file) ? parseEnvFile(await readFile(file, 'utf8')) : {} };
}

/** Desktop ports for a profile instance; the buyer proxy port is the instance's system-proxy slot minus one. */
async function profileInstance(ctx) {
  const instance = await chooseDesktopInstance(`${ctx.name}-${MAINNET_PROFILE}`.slice(0, 40));
  const ports = resolveInstancePorts(instance);
  const free = async (port) => !(await portOpen(port));
  let buyerProxyPort = ports.systemProxy - 1;
  if (!(await free(buyerProxyPort)) || [8377, 8378].includes(buyerProxyPort)) {
    const { createServer } = await import('node:net');
    buyerProxyPort = await new Promise((resolvePort, rejectPort) => {
      const server = createServer().once('error', rejectPort).listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolvePort(port));
      });
    });
  }
  return { instance, ports: { ...ports, claudeGateway: ports.payments + 3000 }, buyerProxyPort };
}

async function mainnetProfile(options, ctx) {
  checkDesktopBuilt();
  const { file, values } = await localEnvValues(ctx);
  const { instance, ports, buyerProxyPort } = await profileInstance(ctx);
  const profile = await prepareMainnetProfile({ sandboxDir: ctx.paths.dir, root: ctx.root, repo, fileValues: values, envFile: file, fresh: Boolean(options.fresh), buyerProxyPort });
  say(`REAL NETWORK, REAL FUNDS: test wallet ${profile.address} (from ${profile.walletSource}), channel reserve cap ${profile.cap.usdc} USDC`);
  say(`Profile ${profile.paths.dir} (own HOME, mock keychain, no OS proxy changes); buyer proxy 127.0.0.1:${buyerProxyPort}`);
  const env = profileDesktopEnv({ paths: profile.paths, ports, instance });
  return { profile: { ...profile, buyerProxyPort }, env, instance };
}

function checkDesktopBuilt() {
  const required = ['apps/desktop/dist/main/main.js', 'apps/desktop/dist/renderer/index.html', 'apps/cli/dist/cli/index.js', 'plugins/router-local/dist/index.js'];
  const missing = required.filter((file) => !existsSync(join(repo, file)));
  if (missing.length) throw new Error(`Build first (pnpm run build && pnpm --filter @antseed/desktop run build). Missing: ${missing.join(', ')}`);
}

async function mainnet(options, ctx) {
  const { profile, env, instance } = await mainnetProfile(options, ctx);
  try {
    if (options.dev) {
      say(`Starting the desktop in dev mode (Vite hot reload, main-process watcher) as instance ${instance}`);
      const child = spawn('pnpm', ['--filter', '@antseed/desktop', 'run', 'dev'], { cwd: repo, env, stdio: 'inherit' });
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
      process.exitCode = await new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code ?? 1)));
      return;
    }
    say(`Starting the built desktop as instance ${instance}; quit the app to end the session`);
    const electron = createRequire(join(repo, 'apps/desktop/package.json'))('electron');
    const child = spawn(electron, ['.'], { cwd: join(repo, 'apps/desktop'), env, stdio: 'inherit' });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
    process.exitCode = await new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code ?? 1)));
  } finally {
    await profile.release();
  }
}

async function runMainnetScenario(options, ctx, scenario) {
  assertScenarioSupported(scenario, 'mainnet');
  if (!options.realFunds) throw new Error(`Scenario ${scenario.name} spends real USDC; rerun with --real-funds`);
  const { values } = await localEnvValues(ctx);
  const rpcUrl = process.env.BASE_MAINNET_RPC_URL?.trim() || values.BASE_MAINNET_RPC_URL?.trim();
  if (!rpcUrl) throw new Error('Mainnet runs read the deposit through BASE_MAINNET_RPC_URL; put it in .env.local or export it');
  const { profile, env, instance } = await mainnetProfile(options, ctx);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportDir = join(ctx.paths.reports, `${stamp}-${scenario.name}`);
  await mkdir(reportDir, { recursive: true, mode: 0o700 });
  const sdk = await import(join(repo, 'packages/node/dist/index.js'));
  const reader = mainnetReader(rpcUrl, sdk.getChainConfig('base-mainnet'));
  const sb = createMainnetApi({ repo, env, instance, profile, reader, reportDir, eventsPath: join(reportDir, 'events.jsonl'), capMicros: profile.cap.micros, strict: Boolean(options.strict), trace: Boolean(options.trace) });
  const report = { scenario: scenario.name, description: scenario.description, target: 'mainnet', sandbox: ctx.name, result: 'running', startedAt: new Date().toISOString(), upstream: 'live network', wallet: profile.address, reserveCapUsdc: profile.cap.usdc };
  say(`Running scenario ${scenario.name} on the real network`);
  try {
    await scenario.run(sb);
    report.result = 'passed';
  } catch (error) {
    report.result = 'failed';
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    const summary = sb.summary();
    Object.assign(report, { finishedAt: new Date().toISOString(), checks: summary.checks, knownIssues: summary.knownIssues, strict: Boolean(options.strict), metrics: summary.metrics });
    await sb.dispose();
    await profile.release();
    await saveJson(join(reportDir, 'report.json'), report);
    await saveJson(join(reportDir, 'metrics.json'), summary.metrics);
    await writeHtmlReport(reportDir, report).catch((error) => say(`HTML report failed: ${error.message}`));
  }
  printReport(report, reportDir);
}

function printReport(report, reportDir) {
  for (const check of report.checks) say(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}`);
  for (const issue of report.knownIssues ?? []) say(`${issue.ok ? 'PASS' : 'KNOWN'} ${issue.name}${issue.ok ? '' : ` (${issue.issue}; ${JSON.stringify(issue.detail)})`}`);
  if (report.error) say(`Error: ${report.error}`);
  say(`${report.result.toUpperCase()}: ${join(reportDir, 'report.json')}`);
  say(`HTML report: ${join(reportDir, 'index.html')}  (pnpm sandbox report --open | --serve)`);
  if (existsSync(join(reportDir, 'video', 'desktop.webm'))) say(`Video: ${join(reportDir, 'video', 'desktop.webm')}`);
  if (existsSync(join(reportDir, 'trace.zip'))) say(`Trace: npx playwright show-trace ${join(reportDir, 'trace.zip')}`);
}

async function chooseDesktopInstance(preferred) {
  const free = (port) => portOpen(port).then((open) => !open);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const name = attempt === 0 ? preferred : `${preferred}-${attempt}`;
    if ((await Promise.all(Object.values(resolveInstancePorts(name)).map(free))).every(Boolean)) return name;
  }
  throw new Error('No free desktop instance port set; existing processes were left untouched');
}

async function desktop(options, ctx) {
  const state = await runningState(ctx.paths);
  if (!state.running) throw new Error(`Sandbox ${ctx.name} is not running; start it with pnpm sandbox up`);
  const manifest = validateManifest(state.manifest, { dir: ctx.paths.dir });
  const response = await fetch(`${manifest.proxyUrl}/_antseed/status`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => null);
  if (!response?.ok || response.startedAt !== manifest.buyerStartedAt) throw new Error('Sandbox buyer is not healthy; refusing to start a desktop (it would start its own buyer)');
  const instance = await chooseDesktopInstance(manifest.desktopInstance ?? manifest.name);
  const cdpPort = options.cdpPort === undefined ? undefined : Number(options.cdpPort);
  if (cdpPort !== undefined) {
    if (FORBIDDEN_PORTS.has(cdpPort) || Object.values(resolveInstancePorts(instance)).includes(cdpPort)) throw new Error(`--cdp-port ${cdpPort} collides with an AntSeed or desktop instance port`);
    if (await portOpen(cdpPort)) throw new Error(`--cdp-port ${cdpPort} is already in use`);
  }
  // Keep the real macOS HOME for Electron's login Keychain. Attach-only mode
  // reads the sandbox wallet/config through explicit paths below and never
  // falls back to HOME for its buyer state.
  const env = isolatedEnv(process.env, process.env.HOME ?? manifest.home, {
    VOLTA_HOME: process.env.VOLTA_HOME || join(process.env.HOME, '.volta'),
    ANTSEED_DESKTOP_ATTACH_ONLY: '1',
    ANTSEED_CONFIG_PATH: manifest.buyerConfig,
    ANTSEED_DESKTOP_CONNECT_DATA_DIR: manifest.buyerDir,
    ANTSEED_PROXY_URL: manifest.proxyUrl,
    ANTSEED_BASE_RPC_URL: manifest.rpcUrl,
    ...(cdpPort === undefined ? {} : { ANTSEED_DESKTOP_CDP_PORT: String(cdpPort) }),
  });
  if (cdpPort !== undefined) say(`CDP on 127.0.0.1:${cdpPort} (agent-browser connect ${cdpPort})`);
  say(`Attaching desktop instance ${instance} to ${manifest.proxyUrl} (attach-only, sandbox wallet)`);
  const child = spawn('pnpm', ['dev:desktop:instance', instance], { cwd: repo, env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  const code = await new Promise((resolveExit) => child.once('exit', (exitCode) => resolveExit(exitCode ?? 1)));
  process.exitCode = code;
}

async function logs(options, ctx) {
  const component = options.positional[0] ?? 'supervisor';
  if (!/^[a-z0-9-]+$/.test(component)) throw new Error('Invalid log component');
  const file = join(ctx.paths.logs, `${component}.log`);
  if (!existsSync(file)) {
    const available = existsSync(ctx.paths.logs) ? (await readdir(ctx.paths.logs)).map((entry) => entry.replace(/\.log$/, '')) : [];
    throw new Error(`No log ${component}. Available: ${available.join(', ') || 'none'}`);
  }
  if (options.follow) {
    const child = spawn('tail', ['-n', '200', '-f', file], { stdio: 'inherit' });
    await new Promise((r) => child.once('exit', r));
  } else {
    const text = await readFile(file, 'utf8');
    process.stdout.write(text.split('\n').slice(-200).join('\n'));
  }
}

async function reportCommand(options, ctx) {
  const runs = existsSync(ctx.paths.reports) ? (await readdir(ctx.paths.reports)).filter((name) => !name.startsWith('.')).sort() : [];
  if (options.serve) {
    const server = await serveReports({ dir: ctx.paths.reports, host: options.host ?? '127.0.0.1', port: Number(options.port ?? 0) });
    say(`Serving ${ctx.paths.reports} at ${server.url}  (Ctrl-C to stop)`);
    if (runs.length) say(`Latest: ${server.url}${runs.at(-1)}/index.html`);
    if (server.host !== '127.0.0.1') say('Warning: reports are reachable from the network; they contain wallet addresses and logs');
    await new Promise((resolveStop) => { for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, resolveStop); });
    await server.stop();
    return;
  }
  const name = options.positional[0] ?? runs.at(-1);
  if (!name || !runs.includes(name)) throw new Error(name ? `No run ${name} in ${ctx.paths.reports}` : `No reports yet in ${ctx.paths.reports}`);
  const dir = join(ctx.paths.reports, name);
  const index = join(dir, 'index.html');
  if (!existsSync(index)) {
    const report = await readJson(join(dir, 'report.json'));
    if (!report) throw new Error(`Run ${name} has no report.json`);
    await writeHtmlReport(dir, report);
  }
  const report = await readJson(join(dir, 'report.json'));
  console.log(`${name}  ${report?.result ?? 'unknown'}`);
  console.log(`  html    ${index}`);
  console.log(`  json    ${join(dir, 'report.json')}`);
  if (existsSync(join(dir, 'video', 'desktop.webm'))) console.log(`  video   ${join(dir, 'video', 'desktop.webm')}`);
  if (existsSync(join(dir, 'screenshots'))) console.log(`  shots   ${join(dir, 'screenshots')}`);
  if (existsSync(join(dir, 'trace.zip'))) console.log(`  trace   npx playwright show-trace ${join(dir, 'trace.zip')}`);
  if (options.open) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [index], { stdio: 'ignore', detached: true }).unref();
}

const SHARE_TOOLS = { Xvfb: 'xvfb', x11vnc: 'x11vnc' };

function commandExists(command) {
  return spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}

function gitBranch(worktree) {
  const result = spawnSync('git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

/** Share preflight: Linux virtual display tools, noVNC, the built desktop and (unless --no-tailscale) a logged-in Tailscale without Funnel. */
function shareChecks(options) {
  if (process.platform !== 'linux') throw new Error('pnpm sandbox share runs on a Linux server (virtual display); on a Mac use pnpm sandbox desktop');
  const missing = Object.entries(SHARE_TOOLS).filter(([command]) => !commandExists(command)).map(([, pkg]) => pkg);
  const noVncDir = findNoVncDir(process.env.ANTSEED_SANDBOX_NOVNC_DIR);
  if (!noVncDir) missing.push('novnc');
  if (missing.length) throw new Error(`Missing ${missing.join(', ')}. Install: sudo apt-get install -y ${missing.join(' ')} openbox  (noVNC elsewhere: set ANTSEED_SANDBOX_NOVNC_DIR to a dir with vnc.html)`);
  const windowManager = ['openbox', 'fluxbox', 'matchbox-window-manager'].find(commandExists) ?? null;
  if (!windowManager) say('No window manager found; windows cannot be moved or resized. Recommended: sudo apt-get install -y openbox');
  for (const file of ['dist/main/main.js', 'dist/renderer/index.html']) {
    if (!existsSync(join(repo, 'apps/desktop', file))) throw new Error(`Desktop is not built (missing apps/desktop/${file}); run pnpm --filter @antseed/desktop run build:main && pnpm --filter @antseed/desktop run build:renderer`);
  }
  if (options.noTailscale) return { noVncDir, windowManager, dnsName: null };
  if (!commandExists('tailscale')) throw new Error('Tailscale is not installed (https://tailscale.com/download/linux), or use --no-tailscale and an SSH tunnel');
  const status = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
  const tailnet = parseTailscaleStatus(status.status === 0 ? JSON.parse(status.stdout) : null);
  if (!tailnet.running || !tailnet.dnsName) throw new Error('Tailscale is not logged in on this server; run sudo tailscale up (and enable MagicDNS + HTTPS certificates for the tailnet)');
  const serve = spawnSync('tailscale', ['serve', 'status', '--json'], { encoding: 'utf8' });
  if (serve.status !== 0) throw new Error(`tailscale serve is not usable by this user: ${(serve.stderr || serve.stdout).trim()}. Run once: sudo tailscale set --operator=$USER`);
  if (funnelEnabled(serve.stdout.trim() ? JSON.parse(serve.stdout) : {}, tailnet.dnsName)) throw new Error('Tailscale Funnel is on for port 443 of this server, which would put the sandbox on the public internet; turn it off (tailscale funnel reset) first');
  return { noVncDir, windowManager, dnsName: tailnet.dnsName };
}

async function shareState(ctx) {
  const state = await readJson(join(ctx.paths.dir, 'share.json'));
  return { state, alive: Boolean(state?.host && isOwnedProcessAlive(state.host)) };
}

async function stopShare(ctx, { quiet = false } = {}) {
  const { state, alive } = await shareState(ctx);
  if (!alive) {
    if (!quiet) say(`No share running for ${ctx.name}`);
    return false;
  }
  say('Stopping share (desktop, display, VNC, tailscale serve)');
  await killOwned(state.host, { graceMs: 20_000 });
  for (const entry of state.processes ?? []) await killOwned(entry, { graceMs: 5_000 });
  if (state.tailscale?.path) spawnSync('tailscale', ['serve', '--https=443', `--set-path=${state.tailscale.path}`, 'off'], { stdio: 'ignore' });
  return true;
}

async function share(options, ctx) {
  if (options.stop) { await stopShare(ctx); return; }
  const existing = await shareState(ctx);
  if (existing.alive) {
    if (options.json) console.log(JSON.stringify(existing.state, null, 2));
    else say(`Already shared: ${existing.state.url}  (pnpm sandbox share --stop)`);
    return;
  }
  const checks = shareChecks(options);
  let state = await runningState(ctx.paths);
  if (!state.running) {
    say(`Sandbox ${ctx.name} is not running; starting it (${options.scenario ? `scenario ${options.scenario} topology` : 'default topology'})`);
    await up(options, ctx);
    state = await runningState(ctx.paths);
  }
  validateManifest(state.manifest, { dir: ctx.paths.dir });
  const idleMinutes = Number(options.idle ?? 120);
  await saveJson(join(ctx.paths.dir, 'share.plan.json'), {
    noVncDir: checks.noVncDir, windowManager: checks.windowManager, dnsName: checks.dnsName, tailscale: !options.noTailscale, idleMinutes,
    width: 1440, height: 900, fresh: Boolean(options.fresh), branch: gitBranch(ctx.worktree),
  });
  const logPath = join(ctx.paths.logs, 'share.log');
  const out = openSync(logPath, 'a');
  const child = spawn(process.execPath, [join(here, 'share-host.mjs'), ctx.root, ctx.name], { cwd: repo, env: process.env, detached: true, stdio: ['ignore', out, out] });
  closeSync(out);
  child.unref();
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const { state: current } = await shareState(ctx);
    if (current?.host?.pid === child.pid && current.running) {
      if (options.json) { console.log(JSON.stringify(current, null, 2)); return; }
      say(`Desktop shared: ${current.url}`);
      if (!current.tailscale) say(`Tailnet publishing skipped; from your machine: ssh -L ${current.port}:127.0.0.1:${current.port} <server>, then open http://127.0.0.1:${current.port}/`);
      say(`Stops after ${idleMinutes} min without viewers, on pnpm sandbox down, or with pnpm sandbox share --stop`);
      return;
    }
    if (current?.host?.pid === child.pid && current.startError) throw new Error(`Share failed: ${current.startError} (see ${logPath})`);
    if (child.exitCode !== null) throw new Error(`Share host exited during startup (see ${logPath})`);
  }
  throw new Error(`Timed out starting the share (see ${logPath}); run pnpm sandbox share --stop`);
}

async function list(ctx) {
  let entries = [];
  try { entries = await readdir(ctx.root); } catch { /* none yet */ }
  for (const entry of entries.filter((e) => !e.startsWith('.')).sort()) {
    const paths = sandboxPaths(ctx.root, entry);
    const state = await runningState(paths);
    const size = existsSync(paths.manifest) ? statSync(paths.manifest).mtime.toISOString() : '';
    console.log(`${entry.padEnd(48)} ${state.running ? 'running' : state.lock.state === 'stale' ? 'stale  ' : 'stopped'}  ${state.manifest?.worktree ?? ''}  ${size}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help' || options.help) { console.log(HELP); return; }
  const ctx = context(options);
  switch (options.command) {
    case 'up': {
      const manifest = await up(options, ctx);
      say(`Ready: proxy ${manifest.proxyUrl}, rpc ${manifest.rpcUrl}`);
      console.log(`\n${envExports(manifest)}\n`);
      say('Next: pnpm sandbox status | pnpm sandbox run chat-basic | pnpm sandbox desktop | pnpm sandbox down');
      break;
    }
    case 'down': await down(options, ctx); break;
    case 'status': await status(options, ctx); break;
    case 'run': await runScenario(options, ctx); break;
    case 'desktop': await desktop(options, ctx); break;
    case 'logs': await logs(options, ctx); break;
    case 'list': await list(ctx); break;
    case 'report': await reportCommand(options, ctx); break;
    case 'share': await share(options, ctx); break;
    case 'mainnet': await mainnet(options, ctx); break;
    default: console.log(HELP);
  }
}

main().catch((error) => {
  console.error(`[sandbox] ${error.message}`);
  process.exitCode = 1;
});
