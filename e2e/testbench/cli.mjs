#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveInstancePorts } from '../../apps/desktop/scripts/dev-instance-config.mjs';
import { legacyCacheHome, sharedCacheHome } from './lib/cache.mjs';
import { loadSourceConfig, resolveConfigSource } from './lib/config.mjs';
import { loadControlClient } from './lib/control.mjs';
import { BUYER_KEY_ENV, FORBIDDEN_PORTS, isolatedEnv, parseEnvFile, resolveBuyerKey, resolveForkUrl, resolveLiveKeys, writeBuyerKey } from './lib/env.mjs';
import { assertAttachOnlyPlatform, attachOnlyEnv, electronRootArgs, FFMPEG_INSTALL, playwrightFfmpeg } from './lib/desktop.mjs';
import { inspectLock, isOwnedProcessAlive, killOwned, ownProcessEntry } from './lib/lock.mjs';
import { scenarioFile, scenarioFiles, SCENARIOS_DIR } from './lib/scenarios.mjs';
import { cleanupStale, settleSlot } from './lib/stale.mjs';
import { lifecycleState, readJson, saveJson, shutdownProblems, validateManifest } from './lib/manifest.mjs';
import { HELP, parseArgs } from './lib/options.mjs';
import { testbenchName, testbenchPaths, testbenchRoot, worktreeRoot } from './lib/paths.mjs';
import { derive, randomSeed } from './lib/prng.mjs';
import { applyCheckVerdict, classifyScenarioError, computeDrift, deliveryMetrics, driftLines, gitInfo, previousReport, recordTeardownFailure, rerunCommand, RESULT_EXIT_CODES, runWithTimeout } from './lib/report.mjs';
import { createTestbenchApi } from './lib/tb.mjs';
import { writeHtmlReport } from './lib/report-html.mjs';
import { serveReports } from './lib/report-server.mjs';
import { createMainnetApi, mainnetReader } from './lib/mainnet-run.mjs';
import { assertProfilePlatform, MAINNET_PROFILE, prepareMainnetProfile, profileDesktopEnv, walletAddress } from './lib/mainnet.mjs';
import { cleanupShare, findNoVncDir, funnelEnabled, parseTailscaleStatus } from './lib/share.mjs';
import { cliEntry } from './lib/cli-node.mjs';
import { reattachDecision, resolveIdleMinutes, startHeartbeat } from './lib/watchdog.mjs';
import { assertScenarioSupported, assertUpstreamReusable, chooseMode, chooseTarget, normalizeTopology, requestedMode, requestedUpstream, topologyDifferences, topologyFingerprint, topologySummary, validateScenarioModule } from './lib/topology.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const say = (message) => console.log(`[testbench] ${message}`);

function context(options) {
  const worktree = worktreeRoot();
  const root = testbenchRoot();
  const name = testbenchName(worktree, options.slot);
  return { worktree, root, name, paths: testbenchPaths(root, name) };
}

async function runningState(paths) {
  const lock = await inspectLock(paths.lock);
  const manifest = await readJson(paths.manifest);
  return { lock, manifest, running: lock.state === 'held' && manifest?.running === true };
}

/** A testbench whose `run` died without `down` is not reused, whatever the watchdog has got to: returns the state after stopping it. */
async function retireOrphan(ctx, state) {
  const starter = state.manifest?.starter ?? null;
  if (reattachDecision({ running: state.running, starter, starterAlive: isOwnedProcessAlive(starter) }) !== 'restart') return state;
  say(`Testbench ${ctx.name} was started by a run that is gone (pid ${starter.pid}); stopping it and starting fresh`);
  await down({}, ctx);
  return runningState(ctx.paths);
}

/** From here on nobody drives the testbench: it stays up, under the idle budget. */
async function releaseStarter(ctx) {
  await (await loadControlClient(ctx.paths.control)).releaseStarter(ownProcessEntry());
}

function portOpen(port) {
  return new Promise((resolvePort) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolvePort(true); });
    socket.once('error', () => resolvePort(false));
    socket.setTimeout(1000, () => { socket.destroy(); resolvePort(false); });
  });
}

async function scenarioModule(name) {
  const file = scenarioFile(name);
  if (!file) throw new Error(`No scenario ${name} (looked in ${SCENARIOS_DIR} and its group folders); pnpm testbench scenarios lists them`);
  return validateScenarioModule(await import(pathToFileURL(file).href), name);
}

function checkBuilt(target = 'fork', mode = 'sdk') {
  const pinned = existsSync(join(repo, '.nvmrc')) ? readFileSync(join(repo, '.nvmrc'), 'utf8').trim().split('.')[0] : null;
  if (pinned && process.versions.node.split('.')[0] !== pinned) {
    throw new Error(`Node ${process.versions.node} does not match .nvmrc (${pinned}.x); native modules (better-sqlite3) would fail to load and disable buyer payments. Switch Node (volta/nvm) and retry`);
  }
  const required = ['packages/node/dist/index.js', 'apps/cli/dist/proxy/buyer-proxy.js', 'plugins/provider-openai/dist/index.js', ...(mode === 'cli' ? [cliEntry('.'), 'plugins/router-local/dist/index.js'] : [])];
  const missing = required.filter((file) => !existsSync(join(repo, file)));
  if (missing.length) throw new Error(`Build first (pnpm run build). Missing: ${missing.join(', ')}`);
  for (const command of target === 'local' ? ['anvil', 'forge'] : ['anvil']) {
    if (spawnSync(command, ['--version'], { stdio: 'ignore' }).status !== 0) throw new Error(`Install Foundry and put ${command} on PATH`);
  }
  if (target === 'local' && !existsSync(join(repo, 'packages/contracts/lib/forge-std/src/Script.sol'))) {
    throw new Error('Local chain needs forge-std: (cd packages/contracts && forge install foundry-rs/forge-std --no-git)');
  }
}

/** A running testbench keeps the seed it started with; say so when the command line asked for another. */
function warnSeedIgnored(options, manifest) {
  if (options.seedGiven && manifest.seed !== options.seed) say(`Ignoring --seed ${options.seed}: this testbench started with seed ${manifest.seed ?? 'unknown'}; run pnpm testbench down first to use another`);
}

async function up(options, ctx, topologyOverride) {
  const { paths } = ctx;
  const target = options.chain ?? 'fork';
  const settled = await settleSlot({
    state: await retireOrphan(ctx, await runningState(paths)),
    readState: () => runningState(paths),
    cleanup: (manifest) => cleanupStale(paths, manifest),
    say,
  });
  const current = settled.state;
  if (settled.action === 'reattach') {
    if (options.chain && (current.manifest.target ?? 'fork') !== options.chain) {
      throw new Error(`Testbench ${ctx.name} is running on chain ${current.manifest.target ?? 'fork'}; run pnpm testbench down first or use --slot`);
    }
    if (options.mode && (current.manifest.mode ?? 'sdk') !== options.mode) {
      throw new Error(`Testbench ${ctx.name} is running in ${current.manifest.mode ?? 'sdk'} mode; run pnpm testbench down first or use --slot`);
    }
    assertUpstreamReusable(current.manifest.upstream, requestedUpstream(options.live), `Testbench ${ctx.name}`);
    say(`Testbench ${ctx.name} is already running; reattaching`);
    warnSeedIgnored(options, current.manifest);
    return current.manifest;
  }
  if (settled.action === 'wait') {
    throw new Error(`Testbench ${ctx.name} is starting or stopping (${settled.reason ?? `pid ${current.lock.holder?.pid ?? 'unknown'}`}); wait, or run pnpm testbench down --force`);
  }
  const scenario = options.scenario ? await scenarioModule(options.scenario) : null;
  checkBuilt(target, requestedMode(options.mode, topologyOverride ?? scenario?.topology));
  if (target === 'local' && options.block !== undefined) throw new Error('--block only applies to --chain fork');
  if (target !== 'local' && options.contracts !== undefined) throw new Error('--contracts only applies to --chain local');
  const source = resolveConfigSource({ explicit: options.config, worktree: ctx.worktree });
  const config = await loadSourceConfig(source);
  const topology = normalizeTopology(topologyOverride ?? scenario?.topology ?? {}, config.cleaned, { depositUsdc: options.depositUsdc, block: options.block, mode: options.mode, contracts: options.contracts });
  const upstream = requestedUpstream(options.live);
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
    const envFile = options.envFile ? resolve(options.envFile) : join(ctx.worktree, '.antseed-testbench.env');
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
  const localEnv = await localEnvValues(ctx);
  const buyerKey = resolveBuyerKey({ fileValues: localEnv.values, envFile: localEnv.file });
  const expectedBuyer = buyerKey ? walletAddress(buyerKey.hex) : null;
  if (buyerKey) {
    await writeBuyerKey(paths.buyer, buyerKey.hex);
    say(`Buyer wallet ${expectedBuyer} from ${BUYER_KEY_ENV} (${buyerKey.source})`);
  } else {
    say(`Buyer wallet: this testbench's own key (${join(paths.buyer, 'identity.key')}); set ${BUYER_KEY_ENV} in .env.local to choose one`);
  }
  let forkUrl;
  if (target === 'fork') {
    const fork = resolveForkUrl({ fileValues: localEnv.values, envFile: localEnv.file });
    forkUrl = fork.url;
    say(`Fork RPC: BASE_MAINNET_RPC_URL from ${fork.source}`);
  } else {
    say('Local chain: plain Anvil + packages/contracts deployed from source (no fork, no RPC key)');
  }
  // `share` starts a testbench too, without a --seed of its own.
  const seed = options.seed ?? randomSeed();
  const idleMinutes = resolveIdleMinutes();
  await saveJson(join(paths.config, 'plan.json'), {
    worktree: ctx.worktree, target, mode: topology.mode, seed, starter: ownProcessEntry(), idleMinutes, topology, upstream, liveKeys: [...new Set(liveKeys)], verbose: Boolean(options.verbose),
    configHash: config.hash, configOrigin: config.origin, cacheHome: sharedCacheHome(process.env, ctx.root), legacyCacheHome: legacyCacheHome(),
  });
  say(`Starting ${ctx.name} (chain: ${target}, mode: ${topology.mode}, seed: ${seed}, config: ${config.origin}, upstream: ${upstream}, sellers: ${topology.sellers.map((seller) => seller.id).join(', ')})`);
  if (config.dropped.length) say(`Ignored config settings: ${config.dropped.join(', ')}`);
  const logPath = join(paths.logs, 'supervisor.log');
  const logOffset = existsSync(logPath) ? statSync(logPath).size : 0;
  const out = openSync(logPath, 'a');
  const env = isolatedEnv(process.env, paths.home, {
    ...(forkUrl ? { ANTSEED_TESTBENCH_FORK_URL: forkUrl } : { ANTSEED_TESTBENCH_TOOL_HOME: process.env.HOME }),
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
      if (expectedBuyer && manifest.buyer?.address?.toLowerCase() !== expectedBuyer.toLowerCase()) {
        await down({}, ctx).catch(() => {});
        throw new Error(`Testbench buyer pays from ${manifest.buyer?.address}, not ${expectedBuyer} from ${BUYER_KEY_ENV}; stopped it`);
      }
      return manifest;
    }
    if (child.exitCode !== null || (manifest?.startError && manifest.supervisor?.pid === child.pid)) {
      throw new Error(`Testbench failed to start: ${manifest?.startError ?? 'supervisor exited'} (see ${logPath})`);
    }
    try { process.kill(child.pid, 0); } catch { throw new Error(`Testbench supervisor exited during startup (see ${logPath})`); }
  }
  throw new Error(`Timed out waiting for the testbench to start (see ${logPath}); run pnpm testbench down to clean up`);
}

async function down(options, ctx) {
  const { paths } = ctx;
  await stopShare(ctx, { quiet: true });
  const state = await runningState(paths);
  if (state.lock.state === 'free' && !state.manifest?.running) {
    // Its shutdown may already have run (the watchdog, an earlier down) and failed; that still fails `down`.
    const problems = shutdownProblems(state.manifest);
    if (problems.length) throw new Error(`Testbench ${ctx.name} is not running, but its last shutdown had problems: ${problems.join('; ')} (see ${join(paths.logs, 'supervisor.log')}; the next pnpm testbench up starts fresh)`);
    say(`Testbench ${ctx.name} is not running`);
    return;
  }
  if (state.lock.state === 'held' && !options.force) {
    say('Settling channels and stopping (Anvil stays up until channels close)...');
    const control = await loadControlClient(paths.control).catch(() => null);
    if (!control) throw new Error('Testbench is still starting; wait, or use pnpm testbench down --force');
    // The watchdog may have started the same shutdown and closed the control API already.
    await control.shutdown().catch(async (error) => { if (!(await readJson(paths.manifest))?.stoppingAt) throw error; });
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline && isOwnedProcessAlive(state.lock.holder)) await new Promise((r) => setTimeout(r, 500));
    if (isOwnedProcessAlive(state.lock.holder)) throw new Error('Supervisor did not stop in 5 minutes; use pnpm testbench down --force');
  } else {
    say(`Force-stopping owned processes: ${(await cleanupStale(paths, state.manifest)).results.join(', ') || 'none alive'}`);
  }
  const manifest = await readJson(paths.manifest);
  const ports = [manifest?.anvil?.port, manifest?.proxyPort, manifest?.bootstrap?.port, ...(manifest?.sellers ?? []).map((seller) => seller.signalingPort)].filter(Boolean);
  const open = [];
  for (const port of ports) if (await portOpen(port)) open.push(port);
  if (manifest?.shutdownErrors?.length) say(`Shutdown reported: ${manifest.shutdownErrors.join('; ')}`);
  if (manifest?.finalBalances) say(`Buyer deposit after close: available=${manifest.finalBalances.availableMicroUsdc} reserved=${manifest.finalBalances.reservedMicroUsdc}`);
  if (open.length) say(`Warning: ports still accepting connections: ${open.join(', ')} (another process may have taken them)`);
  // Cleanup above is best effort; a stop that left errors or locked reserve fails `down`, and with it a run.
  const problems = shutdownProblems(manifest);
  if (problems.length) throw new Error(`Testbench ${ctx.name} stopped with problems: ${problems.join('; ')} (see ${join(paths.logs, 'supervisor.log')})`);
  say(`Testbench ${ctx.name} stopped`);
}

function envExports(manifest) {
  return [
    `export ANTSEED_PROXY_URL=${manifest.proxyUrl}`,
    `export OPENAI_BASE_URL=${manifest.proxyUrl}/v1`,
    `export ANTSEED_TESTBENCH_RPC_URL=${manifest.rpcUrl}`,
    `export ANTSEED_TESTBENCH_NAME=${manifest.name}`,
  ].join('\n');
}

async function status(options, ctx) {
  const state = await runningState(ctx.paths);
  if (!state.running) {
    if (options.json) console.log(JSON.stringify({ name: ctx.name, running: false, lock: state.lock.state }, null, 2));
    else say(`Testbench ${ctx.name} is not running${state.lock.state === 'stale' ? ' (stale lock; pnpm testbench up will clean it up)' : ''}`);
    process.exitCode = options.json ? 0 : 3;
    return;
  }
  if (options.env) { console.log(envExports(state.manifest)); return; }
  const live = await (await loadControlClient(ctx.paths.control)).status();
  if (options.json) { console.log(JSON.stringify({ running: true, ...live }, null, 2)); return; }
  const m = live.manifest;
  const usdc = (micro) => `${(Number(micro) / 1e6).toFixed(6)} USDC`;
  console.log(`Testbench   ${m.name}  (target ${m.target}, mode ${m.mode ?? 'sdk'}, upstream ${m.upstream}, ${m.target === 'local' ? 'local chain 31337' : `fork block ${m.forkBlock}`}, chain block ${live.live.chainBlock})`);
  console.log(`State     ${ctx.paths.dir}`);
  console.log(`Seed      ${m.seed ?? 'unknown'}`);
  console.log(`Proxy     ${m.proxyUrl}`);
  console.log(`RPC       ${m.rpcUrl}  (Anvil pid ${m.anvil.pid})`);
  console.log(`Bootstrap 127.0.0.1:${m.bootstrap.port}`);
  console.log(`Buyer     ${m.buyer.address}  deposit available ${usdc(live.live.buyer.availableMicroUsdc)}, reserved ${usdc(live.live.buyer.reservedMicroUsdc)}`);
  for (const seller of live.live.sellers) {
    const info = m.sellers.find((entry) => entry.id === seller.id);
    console.log(`Seller    ${seller.id.padEnd(10)} ${seller.online ? 'online ' : 'offline'} ${seller.peerId}  ${seller.address}  signaling ${info.signalingPort}  usdc ${usdc(seller.usdcMicro)}  models ${info.models.join(',')}`);
  }
  const { watchdog } = live.live;
  const agoMin = (ms) => `${Math.floor(ms / 60_000)} min`;
  console.log(`Watchdog  ${watchdog.starter ? `stops when starter ${watchdog.starter.pid} is gone` : `idle budget ${watchdog.idleMinutes} min, ${agoMin(watchdog.lastControlRequestAgoMs)} since the last control request`}`);
  console.log(`Peers     buyer sees ${live.live.peersSeenByBuyer.length}: ${live.live.peersSeenByBuyer.join(', ') || 'none'}`);
  console.log(`Channels  ${live.live.channels.length} active`);
  console.log(`\n${envExports(m)}`);
}

/** Starts or reuses the testbench for a scenario. Anything thrown here refused the run before the scenario started. */
async function prepareRun(options, ctx, report) {
  const scenario = await scenarioModule(options.scenario);
  report.description = scenario.description;
  report.target = options.chain ?? scenario.targets[0];
  if (options.chain === 'mainnet' || (!options.chain && scenario.targets[0] === 'mainnet')) return { scenario, mainnet: await prepareMainnetRun(options, ctx, scenario) };
  const before = await retireOrphan(ctx, await runningState(ctx.paths));
  const target = chooseTarget(scenario, { requested: options.chain, running: before.running ? (before.manifest.target ?? 'fork') : null });
  const mode = chooseMode(scenario, { requested: options.mode, running: before.running ? (before.manifest.mode ?? 'sdk') : null });
  report.target = target;
  report.mode = mode;
  assertScenarioSupported(scenario, target, mode);
  if (scenario.requires.includes('desktop')) {
    // Fail before starting a chain: Windows cannot isolate the desktop, and without Playwright's ffmpeg the window never loads.
    assertAttachOnlyPlatform();
    const ffmpeg = playwrightFfmpeg();
    if (!ffmpeg.installed) throw new Error(`Scenario ${scenario.name} drives the desktop, but ${ffmpeg.reason}. Run once: ${FFMPEG_INSTALL}`);
  }
  // Only --live on this command line reaches a real upstream; a running testbench must have been started the same way.
  const upstream = requestedUpstream(options.live);
  if (scenario.requires.includes('liveUpstream') && upstream !== 'live') throw new Error(`Scenario ${scenario.name} needs a real upstream; rerun with --live`);
  if (before.running) assertUpstreamReusable(before.manifest.upstream, upstream, `Testbench ${ctx.name}`);
  if (!before.running) {
    const upStarted = Date.now();
    const manifest = await up({ ...options, chain: target, mode, scenario: scenario.name }, ctx);
    return { scenario, target, mode, manifest, startedHere: true, upMs: Date.now() - upStarted };
  }
  const source = await loadSourceConfig(resolveConfigSource({ explicit: options.config, worktree: ctx.worktree }));
  // Same overrides as `up`; a fork block the run does not pin is whatever the running testbench forked at.
  const block = options.block ?? scenario.topology?.chain?.block ?? before.manifest.topology.chain?.block;
  const wanted = normalizeTopology(scenario.topology ?? {}, source.cleaned, { mode, contracts: options.contracts, depositUsdc: options.depositUsdc, block });
  if (topologyFingerprint(wanted) !== topologyFingerprint(before.manifest.topology)) {
    throw new Error(`Running testbench topology (${topologySummary(before.manifest.topology)}) does not match scenario ${scenario.name} (${topologySummary(wanted)}); differs in ${topologyDifferences(wanted, before.manifest.topology).join(', ')}; run pnpm testbench down first or use --slot`);
  }
  warnSeedIgnored(options, before.manifest);
  return { scenario, target, mode, manifest: before.manifest, startedHere: false };
}

/** Runs the scenario under --run-timeout and files its verdict. Returns tb.summary(). */
async function executeScenario(scenario, tb, report, options) {
  try {
    await runWithTimeout(() => scenario.run(tb), options.runTimeout);
    report.result = 'passed';
  } catch (error) {
    Object.assign(report, { result: classifyScenarioError(error), phase: 'scenario', error: error.message });
  }
  const summary = tb.summary();
  Object.assign(report, { finishedAt: new Date().toISOString(), checks: summary.checks, knownIssues: summary.knownIssues, metrics: summary.metrics });
  applyCheckVerdict(report, { strict: Boolean(options.strict) });
  if (report.result === 'timeout') report.checks = [...report.checks, { name: 'run timeout', ok: false, detail: report.error }];
  return summary;
}

async function saveReport(report, reportDir) {
  report.finishedAt ??= new Date().toISOString();
  report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
  await saveJson(join(reportDir, 'report.json'), report);
}

async function saveHtmlReport(report, reportDir) {
  await writeHtmlReport(reportDir, report).catch((error) => say(`HTML report failed: ${error.message}`));
}

async function runScenario(options, ctx) {
  const startedAt = new Date().toISOString();
  const report = {
    scenario: options.scenario, target: options.chain ?? null, testbench: ctx.name, result: 'running', startedAt, seed: options.seed, mode: 'sdk',
    git: gitInfo(ctx.worktree), node: process.version, strict: Boolean(options.strict), budgets: Boolean(options.budgets), checks: [], knownIssues: [],
  };
  // First, so that a run refused before the scenario still leaves a report.
  const reportDir = join(ctx.paths.reports, `${startedAt.replace(/[:.]/g, '-')}-${options.scenario}`);
  await mkdir(reportDir, { recursive: true, mode: 0o700 });
  let prepared;
  try {
    prepared = await prepareRun(options, ctx, report);
  } catch (error) {
    Object.assign(report, { result: 'blocked', phase: 'up', error: error.message });
    await saveReport(report, reportDir);
    await saveHtmlReport(report, reportDir);
  }
  if (prepared?.mainnet) await runMainnetScenario(options, ctx, prepared, report, reportDir);
  else if (prepared) await runTestbenchScenario(options, ctx, prepared, report, reportDir);
  printReport(report, reportDir, options);
  process.exitCode = RESULT_EXIT_CODES[report.result];
  // A timed-out scenario is still running and cannot be cancelled; its timers must not keep the process alive.
  if (report.result === 'timeout') process.exit();
}

async function runTestbenchScenario(options, ctx, { scenario, target, manifest, startedHere, upMs }, report, reportDir) {
  Object.assign(report, {
    seed: manifest.seed ?? null, mode: manifest.mode ?? 'sdk', reusedTestbench: !startedHere, ...(upMs === undefined ? {} : { upMs }),
    configHash: manifest.configHash, configOrigin: manifest.configOrigin, upstream: manifest.upstream, forkBlock: manifest.forkBlock, forkCache: manifest.forkCache,
    topology: manifest.topology, sellers: manifest.sellers.map(({ id, peerId, address }) => ({ id, peerId, address })), buyer: manifest.buyer,
  });
  // A reused testbench's mocks remember earlier runs' tags, and the payment oracle skips tags it has seen, so a
  // later run on it needs its own streams. Only a run that started its testbench replays from the seed alone.
  const scenarioSeed = startedHere ? manifest.seed : derive(manifest.seed ?? 0, `reuse:${report.startedAt}`);
  let tb;
  let stopHeartbeat = () => {};
  try {
    const sdk = await import(join(repo, 'packages/node/dist/index.js'));
    const chain = sdk.getChainConfig(target === 'local' ? 'base-local' : 'base-mainnet');
    const control = await loadControlClient(ctx.paths.control);
    const self = ownProcessEntry();
    stopHeartbeat = startHeartbeat(() => control.heartbeat(self));
    tb = createTestbenchApi({ manifest, control, eventsPath: join(reportDir, 'events.jsonl'), chain, strict: Boolean(options.strict), repo, reportDir, trace: Boolean(options.trace), seed: scenarioSeed, budgets: scenario.budgets, enforceBudgets: Boolean(options.budgets) });
    say(`Running scenario ${scenario.name} against ${manifest.name} (seed ${report.seed})`);
    const summary = await executeScenario(scenario, tb, report, options);
    if (upMs !== undefined) report.metrics.upMs = upMs;
    const previous = await previousReport(ctx.paths.reports, basename(reportDir), report);
    report.metrics.drift = computeDrift(previous?.report.metrics, report.metrics);
    report.metrics.driftFrom = previous?.dir ?? null;
    await saveReport(report, reportDir);
    const deliveries = await deliveryMetrics(manifest.sellers, control).catch((error) => ({ error: error.message }));
    await saveJson(join(reportDir, 'metrics.json'), { ...summary.metrics, deliveries });
  } catch (error) {
    Object.assign(report, { result: 'error', phase: 'scenario', error: error.message, finishedAt: new Date().toISOString() });
  }
  stopHeartbeat();
  try { await tb?.dispose(); } catch (error) { recordTeardownFailure(report, error); }
  await saveReport(report, reportDir);
  await saveHtmlReport(report, reportDir);
  if (startedHere && !options.keep) {
    try {
      await down({}, ctx);
    } catch (error) {
      say(`Teardown failed: ${error.message}`);
      recordTeardownFailure(report, error);
      await saveReport(report, reportDir);
      await saveHtmlReport(report, reportDir);
    }
  } else if (startedHere) {
    await releaseStarter(ctx).catch((error) => say(`Could not release the testbench (${error.message}); the watchdog will stop it`));
    say('Testbench kept running (--keep); stop it with pnpm testbench down');
  }
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
  assertProfilePlatform();
  checkDesktopBuilt();
  const { file, values } = await localEnvValues(ctx);
  const { instance, ports, buyerProxyPort } = await profileInstance(ctx);
  const profile = await prepareMainnetProfile({ testbenchDir: ctx.paths.dir, root: ctx.root, repo, fileValues: values, envFile: file, fresh: Boolean(options.fresh), buyerProxyPort });
  say(`REAL NETWORK, REAL FUNDS: test wallet ${profile.address} (from ${profile.walletSource}), reserve step and per-request cap ${profile.cap.usdc} USDC; top-ups can reserve more over a session, so the wallet's deposit is the only hard limit`);
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
    const child = spawn(electron, ['.', ...electronRootArgs()], { cwd: join(repo, 'apps/desktop'), env, stdio: 'inherit' });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
    process.exitCode = await new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code ?? 1)));
  } finally {
    await profile.release();
  }
}

async function prepareMainnetRun(options, ctx, scenario) {
  assertScenarioSupported(scenario, 'mainnet');
  if (!options.realFunds) throw new Error(`Scenario ${scenario.name} spends real USDC; rerun with --real-funds`);
  const { values } = await localEnvValues(ctx);
  const rpcUrl = process.env.BASE_MAINNET_RPC_URL?.trim() || values.BASE_MAINNET_RPC_URL?.trim();
  if (!rpcUrl) throw new Error('Mainnet runs read the deposit through BASE_MAINNET_RPC_URL; put it in .env.local or export it');
  return { rpcUrl, ...(await mainnetProfile(options, ctx)) };
}

async function runMainnetScenario(options, ctx, { scenario, mainnet: { rpcUrl, profile, env, instance } }, report, reportDir) {
  Object.assign(report, { target: 'mainnet', upstream: 'live network', wallet: profile.address, reserveCapUsdc: profile.cap.usdc });
  let tb;
  try {
    const sdk = await import(join(repo, 'packages/node/dist/index.js'));
    const reader = mainnetReader(rpcUrl, sdk.getChainConfig('base-mainnet'));
    tb = createMainnetApi({ repo, env, instance, profile, reader, reportDir, eventsPath: join(reportDir, 'events.jsonl'), capMicros: profile.cap.micros, strict: Boolean(options.strict), trace: Boolean(options.trace) });
    say(`Running scenario ${scenario.name} on the real network`);
    const summary = await executeScenario(scenario, tb, report, options);
    await saveReport(report, reportDir);
    await saveJson(join(reportDir, 'metrics.json'), summary.metrics);
  } catch (error) {
    Object.assign(report, { result: 'error', phase: 'scenario', error: error.message, finishedAt: new Date().toISOString() });
  }
  try { await tb?.dispose(); } catch (error) { recordTeardownFailure(report, error); }
  try { await profile.release(); } catch (error) { recordTeardownFailure(report, error); }
  await saveReport(report, reportDir);
  await saveHtmlReport(report, reportDir);
}

function printReport(report, reportDir, options) {
  for (const check of report.checks) say(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}`);
  for (const issue of report.knownIssues ?? []) say(`${issue.ok ? 'PASS' : 'KNOWN'} ${issue.name}${issue.ok ? '' : ` (${issue.issue}; ${JSON.stringify(issue.detail)})`}`);
  for (const [name, { value, max, unit, ok, enforced }] of Object.entries(report.metrics?.budgets ?? {})) {
    if (!ok && !enforced) say(`over budget, not enforced: ${name} ${value ?? 'not measured'} > ${max} ${unit}`);
  }
  for (const line of driftLines(report.metrics?.drift)) say(line);
  if (report.error) say(`Error: ${report.error}`);
  if (report.teardownError) say(`Teardown error: ${report.teardownError}`);
  say(`Seed ${report.seed ?? 'unknown'}, git ${report.git.sha?.slice(0, 9) ?? 'unknown'}${report.git.dirty ? ' (dirty)' : ''}, ${report.durationMs} ms`);
  say(`${report.result.toUpperCase()}: ${join(reportDir, 'report.json')}`);
  say(`HTML report: ${join(reportDir, 'index.html')}  (pnpm testbench report --open | --serve)`);
  if (existsSync(join(reportDir, 'video', 'desktop.webm'))) say(`Video: ${join(reportDir, 'video', 'desktop.webm')}`);
  if (existsSync(join(reportDir, 'trace.zip'))) say(`Trace: npx playwright show-trace ${join(reportDir, 'trace.zip')}`);
  if (report.result !== 'passed') say(`rerun: ${rerunCommand({ ...options, ...report, mode: options.mode, live: report.upstream === 'live' })}`);
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
  assertAttachOnlyPlatform();
  const state = await runningState(ctx.paths);
  if (!state.running) throw new Error(`Testbench ${ctx.name} is not running; start it with pnpm testbench up`);
  const manifest = validateManifest(state.manifest, { dir: ctx.paths.dir });
  const response = await fetch(`${manifest.proxyUrl}/_antseed/status`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => null);
  if (!response?.ok || response.startedAt !== manifest.buyerStartedAt) throw new Error('Testbench buyer is not healthy; refusing to start a desktop (it would start its own buyer)');
  const instance = await chooseDesktopInstance(manifest.desktopInstance ?? manifest.name);
  const cdpPort = options.cdpPort === undefined ? undefined : Number(options.cdpPort);
  if (cdpPort !== undefined) {
    if (FORBIDDEN_PORTS.has(cdpPort) || Object.values(resolveInstancePorts(instance)).includes(cdpPort)) throw new Error(`--cdp-port ${cdpPort} collides with an AntSeed or desktop instance port`);
    if (await portOpen(cdpPort)) throw new Error(`--cdp-port ${cdpPort} is already in use`);
  }
  const env = attachOnlyEnv({ manifest, extra: cdpPort === undefined ? {} : { ANTSEED_DESKTOP_CDP_PORT: String(cdpPort) } });
  if (cdpPort !== undefined) say(`CDP on 127.0.0.1:${cdpPort} (agent-browser connect ${cdpPort})`);
  say(`Attaching desktop instance ${instance} to ${manifest.proxyUrl} (attach-only, testbench wallet)`);
  const child = spawn('pnpm', ['dev:desktop:instance', instance], { cwd: repo, env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  // Chats go through the proxy, which the idle budget cannot see; an attached desktop counts as activity.
  const control = await loadControlClient(ctx.paths.control);
  const self = ownProcessEntry();
  const stopHeartbeat = startHeartbeat(() => control.heartbeat(self));
  const code = await new Promise((resolveExit) => child.once('exit', (exitCode) => resolveExit(exitCode ?? 1)));
  stopHeartbeat();
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
  console.log(`${name}  ${report?.result ?? 'unknown'}${report?.seed === undefined ? '' : `  seed ${report.seed}`}`);
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

/** Share preflight: Linux virtual display tools, noVNC, the built desktop and (unless --no-tailscale) a logged-in Tailscale without Funnel. */
function shareChecks(options) {
  if (process.platform !== 'linux') throw new Error('pnpm testbench share runs on a Linux server (virtual display); on a Mac use pnpm testbench desktop');
  const missing = Object.entries(SHARE_TOOLS).filter(([command]) => !commandExists(command)).map(([, pkg]) => pkg);
  const noVncDir = findNoVncDir(process.env.ANTSEED_TESTBENCH_NOVNC_DIR);
  if (!noVncDir) missing.push('novnc');
  if (missing.length) throw new Error(`Missing ${missing.join(', ')}. Install: sudo apt-get install -y ${missing.join(' ')} openbox  (noVNC elsewhere: set ANTSEED_TESTBENCH_NOVNC_DIR to a dir with vnc.html)`);
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
  if (funnelEnabled(serve.stdout.trim() ? JSON.parse(serve.stdout) : {}, tailnet.dnsName)) throw new Error('Tailscale Funnel is on for port 443 of this server, which would put the testbench on the public internet; turn it off (tailscale funnel reset) first');
  return { noVncDir, windowManager, dnsName: tailnet.dnsName };
}

async function shareState(ctx) {
  const state = await readJson(join(ctx.paths.dir, 'share.json'));
  return { state, alive: Boolean(state?.host && isOwnedProcessAlive(state.host)) };
}

/** Cleans up the recorded share, also when its host died (its desktop, display and VNC outlive it). */
async function stopShare(ctx, { quiet = false } = {}) {
  const { state } = await shareState(ctx);
  const cleaned = await cleanupShare(state, {
    isOwnedProcessAlive, killOwned, say,
    tailscaleOff: (path) => spawnSync('tailscale', ['serve', '--https=443', `--set-path=${path}`, 'off'], { stdio: 'ignore' }),
    save: (next) => saveJson(join(ctx.paths.dir, 'share.json'), next),
  });
  if (!cleaned && !quiet) say(`No share running for ${ctx.name}`);
  return cleaned;
}

async function share(options, ctx) {
  if (options.stop) { await stopShare(ctx); return; }
  const existing = await shareState(ctx);
  if (existing.alive) {
    if (options.json) console.log(JSON.stringify(existing.state, null, 2));
    else say(`Already shared: ${existing.state.url}  (pnpm testbench share --stop)`);
    return;
  }
  const checks = shareChecks(options);
  // A share whose host died leaves its children and route behind; clean them up before share.json is replaced.
  await stopShare(ctx, { quiet: true });
  let state = await runningState(ctx.paths);
  if (!state.running) {
    say(`Testbench ${ctx.name} is not running; starting it (${options.scenario ? `scenario ${options.scenario} topology` : 'default topology'})`);
    await up(options, ctx);
    await releaseStarter(ctx);
    state = await runningState(ctx.paths);
  }
  validateManifest(state.manifest, { dir: ctx.paths.dir });
  const idleMinutes = Number(options.idle ?? 120);
  await saveJson(join(ctx.paths.dir, 'share.plan.json'), {
    noVncDir: checks.noVncDir, windowManager: checks.windowManager, dnsName: checks.dnsName, tailscale: !options.noTailscale, idleMinutes,
    width: 1440, height: 900, fresh: Boolean(options.fresh), branch: gitInfo(ctx.worktree).branch ?? 'unknown',
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
      say(`Stops after ${idleMinutes} min without viewers, on pnpm testbench down, or with pnpm testbench share --stop`);
      return;
    }
    if (current?.host?.pid === child.pid && current.startError) throw new Error(`Share failed: ${current.startError} (see ${logPath})`);
    if (child.exitCode !== null) throw new Error(`Share host exited during startup (see ${logPath})`);
  }
  throw new Error(`Timed out starting the share (see ${logPath}); run pnpm testbench share --stop`);
}

async function list(ctx) {
  let entries = [];
  try { entries = await readdir(ctx.root); } catch { /* none yet */ }
  for (const entry of entries.filter((e) => !e.startsWith('.')).sort()) {
    const paths = testbenchPaths(ctx.root, entry);
    const state = await runningState(paths);
    const size = existsSync(paths.manifest) ? statSync(paths.manifest).mtime.toISOString() : '';
    console.log(`${entry.padEnd(48)} ${lifecycleState(state).padEnd(8)}  ${state.manifest?.worktree ?? ''}  ${size}`);
  }
}

/** Every scenario with its targets, description and group (null for top-level, else stress or issues). */
export async function listScenarios() {
  const scenarios = [];
  for (const { name, group } of scenarioFiles()) scenarios.push({ ...(await scenarioModule(name)), group });
  return scenarios;
}

async function scenariosCommand(options) {
  const scenarios = await listScenarios();
  if (options.json) { console.log(JSON.stringify(scenarios.map(({ run, topology, ...rest }) => rest), null, 2)); return; }
  const groups = [...new Set(scenarios.map((scenario) => scenario.group))].sort((a, b) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)));
  for (const group of groups) {
    console.log(group === null ? 'scenarios/' : `\nscenarios/${group}/`);
    for (const scenario of scenarios.filter((entry) => entry.group === group)) console.log(`  ${scenario.name.padEnd(34)} ${scenario.targets.join(',').padEnd(12)} ${scenario.description}`);
  }
  console.log(`\n${scenarios.length} scenarios`);
}

/** The tool was called `pnpm sandbox` before; say which old names are still set so nothing is silently ignored. */
async function warnLegacyNames(ctx) {
  const { file, values } = await localEnvValues(ctx);
  // stderr, so `status --json` output stays parseable.
  const tell = (message) => console.error(`[testbench] ${message}`);
  const legacy = (keys) => keys.filter((key) => key.startsWith('ANTSEED_SANDBOX_'));
  const fromShell = legacy(Object.keys(process.env));
  const fromFile = legacy(Object.keys(values));
  for (const key of new Set([...fromShell, ...fromFile])) {
    tell(`Warning: ${key} (${fromShell.includes(key) ? 'shell' : file}) is no longer read; rename it to ${key.replace('ANTSEED_SANDBOX_', 'ANTSEED_TESTBENCH_')}`);
  }
  const oldRoot = join(homedir(), '.antseed-sandbox');
  if (existsSync(oldRoot) && !process.env.ANTSEED_TESTBENCH_HOME) {
    tell(`Note: state from the old name is in ${oldRoot} and is no longer used; delete it once nothing there is running`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help' || options.help) { console.log(HELP); return; }
  const ctx = context(options);
  await warnLegacyNames(ctx);
  switch (options.command) {
    case 'up': {
      const manifest = await up(options, ctx);
      await releaseStarter(ctx);
      say(`Ready: proxy ${manifest.proxyUrl}, rpc ${manifest.rpcUrl}`);
      console.log(`\n${envExports(manifest)}\n`);
      say('Next: pnpm testbench status | pnpm testbench run chat-basic | pnpm testbench desktop | pnpm testbench down');
      break;
    }
    case 'down': await down(options, ctx); break;
    case 'status': await status(options, ctx); break;
    case 'run': await runScenario(options, ctx).catch((error) => { throw Object.assign(error, { exitCode: RESULT_EXIT_CODES.error }); }); break;
    case 'desktop': await desktop(options, ctx); break;
    case 'logs': await logs(options, ctx); break;
    case 'list': await list(ctx); break;
    case 'scenarios': await scenariosCommand(options); break;
    case 'report': await reportCommand(options, ctx); break;
    case 'share': await share(options, ctx); break;
    case 'mainnet': await mainnet(options, ctx); break;
    default: console.log(HELP);
  }
}

main().catch((error) => {
  console.error(`[testbench] ${error.message}`);
  process.exitCode = error.exitCode ?? 1;
});
