#!/usr/bin/env node
// Long-lived owner of a shared testbench desktop (started detached by `pnpm testbench share`):
// a virtual X display (Xvfb), the attach-only desktop on it, a VNC server on a private unix socket,
// and the share web server (noVNC + reports), published on the tailnet with `tailscale serve`.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadControlClient } from './lib/control.mjs';
import { desktopEnv, electronRootArgs } from './lib/desktop.mjs';
import { ownProcessEntry, processStartTime } from './lib/lock.mjs';
import { readJson, saveJson, validateManifest } from './lib/manifest.mjs';
import { isInside, testbenchPaths } from './lib/paths.mjs';
import { createStateWriter, displayEnv, scheduleForcedExit, startShareServer, startXvfb, xauthorityEntry, xvfbArgs } from './lib/share.mjs';
import { startHeartbeat } from './lib/watchdog.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const [root, name] = process.argv.slice(2);
const paths = testbenchPaths(root, name);
const plan = JSON.parse(await readFile(join(paths.dir, 'share.plan.json'), 'utf8'));
const sharePath = join(paths.dir, 'share.json');
// The display's cookie, inside the 0700 testbench dir: only this account's processes can reach the display.
const authFile = join(paths.dir, 'share-xauthority');
const log = (message) => console.log(`[share] ${new Date().toISOString()} ${message}`);
const children = [];
let server = null;
// Every share.json save goes through this queue, in call order (see createStateWriter).
const shareWriter = createStateWriter((state) => saveJson(sharePath, state));
const writeState = (patch) => shareWriter.write(patch);
let stopping = null;
let lastActivity = Date.now();
let desktopStatus = 'starting';

function track(label, child, logName) {
  const out = createWriteStream(join(paths.logs, `${logName}.log`), { flags: 'a' });
  child.stdout?.pipe(out, { end: false });
  child.stderr?.pipe(out, { end: false });
  const entry = { label, child, process: { pid: child.pid, startedAt: processStartTime(child.pid) } };
  children.push(entry);
  // Recorded as soon as it exists, so a host that dies mid-startup still leaves `share --stop` a list to clean up.
  // Not awaited here; a failed save surfaces at the next flush (ready or stop).
  writeState({ processes: children.map((tracked) => ({ label: tracked.label, ...tracked.process })) }).catch(() => {});
  child.once('exit', (code, signal) => {
    log(`${label} exited (${code ?? signal})`);
    if (!stopping) void stop(`${label} exited`);
  });
  return entry;
}

/**
 * Xvfb picks a free display itself (-displayfd) so concurrent shares never collide. A fresh random cookie per share,
 * in a 0600 file, so other local accounts cannot connect to the display (the VNC socket is private as well).
 */
async function startDisplay() {
  await rm(authFile, { force: true });
  await writeFile(authFile, xauthorityEntry(randomBytes(16)), { mode: 0o600, flag: 'wx' });
  return startXvfb({
    spawnXvfb: () => spawn('Xvfb', xvfbArgs({ width: plan.width, height: plan.height, authFile }), { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] }),
    track: (child) => track('Xvfb', child, 'share-xvfb'),
  });
}

/** x11vnc on a unix socket inside the 0700 testbench dir: no TCP port, so other local users cannot attach. */
async function startVnc(display, socketPath) {
  await rm(socketPath, { force: true });
  const child = spawn('x11vnc', ['-display', display, '-auth', authFile, '-rfbport', '0', '-unixsock', socketPath, '-forever', '-shared', '-nopw', '-noxdamage', '-quiet'], { env: displayEnv(process.env, { display, authFile }), stdio: ['ignore', 'pipe', 'pipe'] });
  track('x11vnc', child, 'share-vnc');
  const deadline = Date.now() + 15_000;
  while (!existsSync(socketPath)) {
    if (Date.now() > deadline) throw new Error('x11vnc did not create its socket within 15s (see logs/share-vnc.log)');
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Optional window manager so the desktop's windows can be moved, resized and stacked in the browser. */
const OPENBOX_CONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <focus><focusNew>yes</focusNew><followMouse>no</followMouse></focus>
  <applications>
    <application class="*" type="normal"><focus>yes</focus></application>
  </applications>
</openbox_config>
`;

async function startWindowManager(display) {
  const manager = plan.windowManager;
  if (!manager) return null;
  const args = [];
  if (manager === 'openbox') {
    const configPath = join(paths.dir, 'share-openbox.xml');
    await writeFile(configPath, OPENBOX_CONFIG);
    args.push('--config-file', configPath);
  }
  const child = spawn(manager, args, { env: displayEnv(process.env, { display, authFile }), stdio: ['ignore', 'pipe', 'pipe'] });
  track(manager, child, 'share-wm');
  return manager;
}

async function startDesktop(display, manifest) {
  const desktopDir = join(repo, 'apps/desktop');
  const { resolveInstancePorts } = await import(pathToFileURL(join(desktopDir, 'scripts/dev-instance-config.mjs')).href);
  const instance = `${manifest.desktopInstance ?? manifest.name}-share`.slice(0, 48);
  const stateDir = join(manifest.dir, 'desktop-share');
  if (!isInside(stateDir, manifest.dir)) throw new Error(`Refusing to reset ${stateDir}`);
  if (plan.fresh) await rm(stateDir, { recursive: true, force: true });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const env = displayEnv(desktopEnv({ manifest, instance, ports: resolveInstancePorts(instance), stateDir: 'desktop-share' }), { display, authFile });
  delete env.WAYLAND_DISPLAY;
  const electron = createRequire(join(desktopDir, 'package.json'))('electron');
  const args = ['.', ...electronRootArgs(), ...(process.env.ANTSEED_TESTBENCH_SHARE_DEBUG_PORT ? [`--remote-debugging-port=${process.env.ANTSEED_TESTBENCH_SHARE_DEBUG_PORT}`, '--remote-debugging-address=127.0.0.1'] : [])];
  const child = spawn(electron, args, { cwd: desktopDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  track('desktop', child, 'share-desktop');
  desktopStatus = 'running';
  return instance;
}

function tailscale(args) {
  const result = spawnSync('tailscale', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`tailscale ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

async function stop(reason) {
  if (stopping) return stopping;
  stopping = (async () => {
    log(`Stopping share (${reason})`);
    const route = shareWriter.state?.tailscale?.path;
    if (route) {
      try { tailscale(['serve', '--https=443', `--set-path=${route}`, 'off']); log(`Removed tailscale serve ${route}`); } catch (error) { log(error.message); }
    }
    await server?.stop().catch(() => {});
    for (const entry of [...children].reverse()) {
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        const exited = once(entry.child, 'exit');
        entry.child.kill('SIGTERM');
        const timer = setTimeout(() => entry.child.kill('SIGKILL'), 10_000);
        try { await exited; } finally { clearTimeout(timer); }
      }
    }
    await rm(join(paths.dir, 'share-vnc.sock'), { force: true });
    await rm(authFile, { force: true });
    if (shareWriter.state) {
      writeState({ running: false, stoppedAt: new Date().toISOString(), stopReason: reason }).catch(() => {});
      try { await shareWriter.flush(); } catch (error) { log(`Could not save share.json: ${error.message}`); process.exitCode = 1; }
    }
    log('Share stopped');
    scheduleForcedExit();
  })();
  return stopping;
}

process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));

async function main() {
  const manifest = validateManifest(await readJson(paths.manifest), { dir: paths.dir });
  await writeState({ running: false, starting: true, host: ownProcessEntry(), name, startedAt: new Date().toISOString(), idleMinutes: plan.idleMinutes });
  const display = await startDisplay();
  log(`Virtual display ${display} (${plan.width}x${plan.height})`);
  const manager = await startWindowManager(display);
  log(manager ? `Window manager ${manager}` : 'No window manager (install openbox to move and resize windows)');
  const socketPath = join(paths.dir, 'share-vnc.sock');
  await startVnc(display, socketPath);
  const instance = await startDesktop(display, manifest);
  log(`Attach-only desktop ${instance} on ${display}`);

  const prefix = plan.tailscale ? `/${name}` : '';
  server = await startShareServer({
    prefix, noVncDir: plan.noVncDir, vncSocket: socketPath, reportsDir: paths.reports, dnsName: plan.dnsName,
    onActivity: () => { lastActivity = Date.now(); },
    info: () => ({ name, branch: plan.branch, target: manifest.target ?? 'fork', upstream: manifest.upstream, desktop: desktopStatus, startedAt: shareWriter.state.startedAt, idleMinutes: plan.idleMinutes }),
  });
  log(`Share server on ${server.url}`);
  let url = server.url;
  if (plan.tailscale) {
    // Recorded before it exists, so a host that dies right after still leaves the route to remove.
    await writeState({ tailscale: { path: prefix, dnsName: plan.dnsName } });
    tailscale(['serve', '--bg', '--yes', '--https=443', `--set-path=${prefix}`, `http://127.0.0.1:${server.port}`]);
    url = `https://${plan.dnsName}${prefix}/`;
    log(`Published on the tailnet: ${url}`);
  }
  await writeState({
    running: true, starting: false, url, localUrl: server.url, port: server.port, display,
    tailscale: plan.tailscale ? { path: prefix, dnsName: plan.dnsName } : null,
    processes: children.map((entry) => ({ label: entry.label, ...entry.process })),
  });
  // Every earlier save (each recorded child) has landed before `share` reads the ready state; a failed one fails startup.
  await shareWriter.flush();

  // A share holds the testbench up for as long as it runs: its own idle rule ends it first.
  const control = await loadControlClient(paths.control);
  const self = ownProcessEntry();
  startHeartbeat(() => control.heartbeat(self));
  const idleMs = plan.idleMinutes * 60_000;
  setInterval(() => {
    if (server.viewerCount() === 0 && Date.now() - lastActivity > idleMs) void stop(`idle for ${plan.idleMinutes} min`);
  }, 30_000).unref();
  setInterval(async () => {
    const current = await readJson(paths.manifest).catch(() => null);
    if (!current?.running || current.supervisor?.pid !== manifest.supervisor.pid) void stop('testbench stopped');
  }, 5_000).unref();
}

try {
  await main();
} catch (error) {
  log(`FAILED: ${error.stack ?? error.message}`);
  if (shareWriter.state) await writeState({ startError: error.message }).catch(() => {});
  await stop('startup failure');
}
