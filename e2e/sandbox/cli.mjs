#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveInstancePorts } from '../../apps/desktop/scripts/dev-instance-config.mjs';
import { legacyCacheHome, sharedCacheHome } from './lib/cache.mjs';
import { loadSourceConfig, resolveConfigSource } from './lib/config.mjs';
import { loadControlClient } from './lib/control.mjs';
import { isolatedEnv, parseEnvFile, resolveLiveKeys } from './lib/env.mjs';
import { inspectLock, isOwnedProcessAlive, killOwned } from './lib/lock.mjs';
import { readJson, saveJson, validateManifest } from './lib/manifest.mjs';
import { HELP, parseArgs } from './lib/options.mjs';
import { sandboxName, sandboxPaths, sandboxRoot, worktreeRoot } from './lib/paths.mjs';
import { aggregateRuns, flattenNumeric } from './lib/metrics.mjs';
import { createSandboxApi } from './lib/sb.mjs';
import { assertScenarioSupported, normalizeTopology, topologyFingerprint, validateScenarioModule } from './lib/topology.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const DEFAULT_FORK_URL = 'https://base.gateway.tenderly.co';
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

function checkBuilt() {
  const required = ['packages/node/dist/index.js', 'apps/cli/dist/proxy/buyer-proxy.js', 'plugins/provider-openai/dist/index.js'];
  const missing = required.filter((file) => !existsSync(join(repo, file)));
  if (missing.length) throw new Error(`Build first (pnpm run build). Missing: ${missing.join(', ')}`);
  for (const command of ['anvil']) {
    if (spawnSync(command, ['--version'], { stdio: 'ignore' }).status !== 0) throw new Error(`Install Foundry and put ${command} on PATH`);
  }
}

async function up(options, ctx, topologyOverride) {
  const { paths } = ctx;
  const current = await runningState(paths);
  if (current.running) {
    say(`Sandbox ${ctx.name} is already running; reattaching`);
    return current.manifest;
  }
  if (current.lock.state === 'held') {
    throw new Error(`Sandbox ${ctx.name} is starting or stopping (pid ${current.lock.holder.pid}); wait, or run pnpm sandbox down --force`);
  }
  if (current.lock.state === 'stale' || current.manifest?.running || current.manifest?.starting) {
    say(`Cleaning up stale sandbox state: ${(await cleanupStale(paths, current.manifest)).join(', ') || 'nothing running'}`);
  }
  checkBuilt();
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
  const forkUrl = process.env.BASE_MAINNET_RPC_URL?.trim() || DEFAULT_FORK_URL;
  if (!/^https?:\/\//.test(forkUrl)) throw new Error('BASE_MAINNET_RPC_URL must be HTTP(S)');
  await saveJson(join(paths.config, 'plan.json'), {
    worktree: ctx.worktree, topology, upstream, liveKeys: [...new Set(liveKeys)], verbose: Boolean(options.verbose),
    configHash: config.hash, configOrigin: config.origin, cacheHome: sharedCacheHome(process.env, ctx.root), legacyCacheHome: legacyCacheHome(),
  });
  say(`Starting ${ctx.name} (config: ${config.origin}, upstream: ${upstream}, sellers: ${topology.sellers.map((seller) => seller.id).join(', ')})`);
  if (config.dropped.length) say(`Ignored config settings: ${config.dropped.join(', ')}`);
  const logPath = join(paths.logs, 'supervisor.log');
  const logOffset = existsSync(logPath) ? statSync(logPath).size : 0;
  const out = openSync(logPath, 'a');
  const env = isolatedEnv(process.env, paths.home, {
    ANTSEED_SANDBOX_FORK_URL: forkUrl,
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
  console.log(`Sandbox   ${m.name}  (target ${m.target}, upstream ${m.upstream}, block ${m.forkBlock}, chain block ${live.live.chainBlock})`);
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

function gitCommit() {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  if (head.status !== 0) return null;
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout.trim().length > 0;
  return `${head.stdout.trim()}${dirty ? '-dirty' : ''}`;
}

async function runScenario(options, ctx) {
  const scenario = await scenarioModule(options.scenario);
  assertScenarioSupported(scenario, 'fork');
  const before = await runningState(ctx.paths);
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
    manifest = await up({ ...options, scenario: scenario.name }, ctx);
    startedHere = true;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportDir = join(ctx.paths.reports, `${stamp}-${scenario.name}`);
  await mkdir(reportDir, { recursive: true, mode: 0o700 });
  const sdk = await import(join(repo, 'packages/node/dist/index.js'));
  const chain = sdk.getChainConfig('base-mainnet');
  const control = await loadControlClient(ctx.paths.control);
  const baseSeed = options.seed ?? 1;
  const repeat = options.repeat ?? 1;
  const report = {
    scenario: scenario.name, description: scenario.description, target: 'fork', sandbox: manifest.name, result: 'running',
    startedAt: new Date().toISOString(), configHash: manifest.configHash, configOrigin: manifest.configOrigin, upstream: manifest.upstream,
    forkBlock: manifest.forkBlock, forkCache: manifest.forkCache, topology: manifest.topology,
    sellers: manifest.sellers.map(({ id, peerId, address }) => ({ id, peerId, address })), buyer: manifest.buyer,
    routers: (manifest.routers ?? []).map(({ id, peerId, address, priceUsd }) => ({ id, peerId, address, priceUsd })),
    seed: baseSeed, ...(repeat > 1 ? { repeat } : {}), gitCommit: gitCommit(), declarative: Boolean(scenario.declarative),
  };
  say(`Running scenario ${scenario.name} against ${manifest.name}${repeat > 1 ? ` (${repeat} repeats, seeds ${baseSeed}..${baseSeed + repeat - 1})` : ''}`);
  const runs = [];
  for (let index = 0; index < repeat; index += 1) {
    const seed = baseSeed + index;
    const runDir = repeat > 1 ? join(reportDir, `run-${index + 1}`) : reportDir;
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    // Every run starts from the same random state for its seed: mock draws and router rankings are reseeded.
    if (manifest.upstream === 'mock') {
      for (const seller of manifest.sellers) await control.setMockProfile(seller.id, { seed }, { resetDraws: true });
    }
    for (const router of manifest.routers ?? []) await control.seedRouter(router.id, seed);
    const sb = createSandboxApi({ manifest, control, eventsPath: join(runDir, 'events.jsonl'), chain, strict: Boolean(options.strict), seed });
    const run = { seed, result: 'running', startedAt: new Date().toISOString() };
    try {
      try {
        await sb.begin();
        await scenario.run(sb);
      } catch (error) {
        run.error = error.message;
      }
      // Global invariants run after every scenario, also after a failed one (on what it got to do).
      try {
        await sb.finish();
      } catch (error) {
        run.error ??= `invariants: ${error.message}`;
      }
      const failures = sb.failures();
      run.result = run.error || failures.length ? 'failed' : 'passed';
      if (!run.error && failures.length) run.error = `${failures.length} check${failures.length === 1 ? '' : 's'} failed: ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? '; ...' : ''}`;
      if (run.result === 'failed') process.exitCode = 1;
    } finally {
      const summary = sb.summary();
      Object.assign(run, { finishedAt: new Date().toISOString(), checks: summary.checks, knownIssues: summary.knownIssues, metrics: summary.metrics, workloads: summary.workloads, invariants: summary.invariants });
      if (summary.workloadRecords.length) await writeFile(join(runDir, 'requests.jsonl'), summary.workloadRecords.map((record) => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 });
      if (repeat > 1) await saveJson(join(runDir, 'report.json'), { ...report, ...run, scenarioRun: index + 1 });
      sb.dispose();
    }
    runs.push(run);
    if (repeat > 1) say(`Run ${index + 1}/${repeat} (seed ${seed}): ${run.result.toUpperCase()}${run.error ? ` - ${run.error}` : ''}`);
  }
  const failed = runs.find((run) => run.result === 'failed');
  if (repeat === 1) {
    const [run] = runs;
    Object.assign(report, { result: run.result, ...(run.error ? { error: run.error } : {}), finishedAt: run.finishedAt, checks: run.checks, knownIssues: run.knownIssues, strict: Boolean(options.strict), metrics: run.metrics });
    if (Object.keys(run.workloads).length) report.workloads = run.workloads;
    if (run.invariants.length) report.invariants = run.invariants;
  } else {
    Object.assign(report, {
      result: failed ? 'failed' : 'passed', ...(failed ? { error: `run with seed ${failed.seed} failed: ${failed.error}` } : {}),
      finishedAt: new Date().toISOString(), strict: Boolean(options.strict),
      checks: runs.flatMap((run) => run.checks.map((check) => ({ ...check, seed: run.seed }))),
      knownIssues: runs.flatMap((run) => run.knownIssues.map((issue) => ({ ...issue, seed: run.seed }))),
      runs: runs.map(({ seed, result, error, metrics }) => ({ seed, result, ...(error ? { error } : {}), metrics })),
      aggregate: aggregateRuns(runs.map((run) => flattenNumeric(run.metrics))),
    });
    report.metrics = report.aggregate;
  }

  for (const check of report.checks) say(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.seed !== undefined ? ` (seed ${check.seed})` : ''}`);
  for (const issue of report.knownIssues ?? []) say(`${issue.ok ? 'PASS' : 'KNOWN'} ${issue.name}${issue.ok ? '' : ` (${issue.issue}; ${JSON.stringify(issue.detail)})`}`);
  for (const [name, workload] of Object.entries(report.workloads ?? {})) {
    const o = workload.overall;
    say(`Workload ${name}: ${o.succeeded}/${o.requests} ok, TTFT p50/p95 ${o.ttftMs.p50}/${o.ttftMs.p95} ms, latency p95 ${o.latencyMs.p95} ms, ${o.outputTokensPerSec} out tok/s, gini ${o.loadSpreadGini}, dropped ${o.dropped}`);
  }
  if (report.aggregate) {
    for (const [key, value] of Object.entries(report.aggregate).filter(([key]) => key.startsWith('workload.'))) say(`  ${key}: ${value.mean} ± ${value.ci95 ?? 'n/a'} (n=${value.n})`);
  }
  if (report.error) say(`Error: ${report.error}`);
  const failedSeeds = runs.filter((run) => run.result === 'failed').map((run) => run.seed);
  if (failedSeeds.length) {
    report.reproduce = failedSeeds.map((seed) => `pnpm sandbox run ${scenario.name} --seed ${seed}`);
    for (const command of report.reproduce.slice(0, 5)) say(`Reproduce: ${command}`);
  }
  await saveJson(join(reportDir, 'report.json'), report);
  await saveJson(join(reportDir, 'metrics.json'), report.metrics);
  say(`${report.result.toUpperCase()}: ${join(reportDir, 'report.json')}`);
  if (startedHere && !options.keep) {
    try { await down({}, ctx); } catch (error) { say(`Teardown failed: ${error.message}`); process.exitCode = 1; }
  } else if (startedHere) say('Sandbox kept running (--keep); stop it with pnpm sandbox down');
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
  });
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
    default: console.log(HELP);
  }
}

main().catch((error) => {
  console.error(`[sandbox] ${error.message}`);
  process.exitCode = 1;
});
