#!/usr/bin/env node
// Long-lived owner of a shared sandbox desktop (started detached by `pnpm sandbox share`):
// a virtual X display (Xvfb), the attach-only desktop on it, a VNC server on a private unix socket,
// and the share web server (noVNC + reports), published on the tailnet with `tailscale serve`.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { desktopEnv } from './lib/desktop.mjs';
import { ownProcessEntry, processStartTime } from './lib/lock.mjs';
import { readJson, saveJson, validateManifest } from './lib/manifest.mjs';
import { isInside, sandboxPaths } from './lib/paths.mjs';
import { startShareServer } from './lib/share.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const [root, name] = process.argv.slice(2);
const paths = sandboxPaths(root, name);
const plan = JSON.parse(await readFile(join(paths.dir, 'share.plan.json'), 'utf8'));
const sharePath = join(paths.dir, 'share.json');
const log = (message) => console.log(`[share] ${new Date().toISOString()} ${message}`);
const children = [];
let server = null;
let shareState = null;
let stopping = null;
let lastActivity = Date.now();
let desktopStatus = 'starting';

const writeState = async (patch) => {
  shareState = { ...shareState, ...patch, updatedAt: new Date().toISOString() };
  await saveJson(sharePath, shareState);
};

function track(label, child, logName) {
  const out = createWriteStream(join(paths.logs, `${logName}.log`), { flags: 'a' });
  child.stdout?.pipe(out, { end: false });
  child.stderr?.pipe(out, { end: false });
  const entry = { label, child, process: { pid: child.pid, startedAt: processStartTime(child.pid) } };
  children.push(entry);
  child.once('exit', (code, signal) => {
    log(`${label} exited (${code ?? signal})`);
    if (!stopping) void stop(`${label} exited`);
  });
  return entry;
}

/** Xvfb picks a free display itself (-displayfd) so concurrent shares never collide. */
async function startDisplay() {
  const child = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', `${plan.width}x${plan.height}x24`, '-nolisten', 'tcp', '-ac'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  let text = '';
  const display = await new Promise((resolveDisplay, reject) => {
    const timer = setTimeout(() => reject(new Error('Xvfb did not report a display within 15s')), 15_000);
    child.stdio[3].on('data', (chunk) => {
      text += chunk.toString();
      if (text.includes('\n')) { clearTimeout(timer); resolveDisplay(`:${text.trim()}`); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Xvfb exited with ${code}`)); });
  });
  track('Xvfb', child, 'share-xvfb');
  return display;
}

/** x11vnc on a unix socket inside the 0700 sandbox dir: no TCP port, so other local users cannot attach. */
async function startVnc(display, socketPath) {
  await rm(socketPath, { force: true });
  const child = spawn('x11vnc', ['-display', display, '-rfbport', '0', '-unixsock', socketPath, '-forever', '-shared', '-nopw', '-noxdamage', '-quiet'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  const child = spawn(manager, args, { env: { ...process.env, DISPLAY: display }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const env = { ...desktopEnv({ manifest, instance, ports: resolveInstancePorts(instance), stateDir: 'desktop-share' }), DISPLAY: display };
  delete env.WAYLAND_DISPLAY;
  const electron = createRequire(join(desktopDir, 'package.json'))('electron');
  const args = ['.', ...(typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : []), ...(process.env.ANTSEED_SANDBOX_SHARE_DEBUG_PORT ? [`--remote-debugging-port=${process.env.ANTSEED_SANDBOX_SHARE_DEBUG_PORT}`, '--remote-debugging-address=127.0.0.1'] : [])];
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
    if (shareState?.tailscale?.path) {
      try { tailscale(['serve', '--https=443', `--set-path=${shareState.tailscale.path}`, 'off']); log(`Removed tailscale serve ${shareState.tailscale.path}`); } catch (error) { log(error.message); }
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
    if (shareState) await writeState({ running: false, stoppedAt: new Date().toISOString(), stopReason: reason });
    log('Share stopped');
    setTimeout(() => process.exit(0), 100).unref();
  })();
  return stopping;
}

process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));

async function main() {
  const manifest = validateManifest(await readJson(paths.manifest), { dir: paths.dir });
  shareState = { running: false, starting: true, host: ownProcessEntry(), name, startedAt: new Date().toISOString(), idleMinutes: plan.idleMinutes };
  await saveJson(sharePath, shareState);
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
    info: () => ({ name, branch: plan.branch, target: manifest.target ?? 'fork', upstream: manifest.upstream, desktop: desktopStatus, startedAt: shareState.startedAt, idleMinutes: plan.idleMinutes }),
  });
  log(`Share server on ${server.url}`);
  let url = server.url;
  if (plan.tailscale) {
    tailscale(['serve', '--bg', '--yes', '--https=443', `--set-path=${prefix}`, `http://127.0.0.1:${server.port}`]);
    url = `https://${plan.dnsName}${prefix}/`;
    log(`Published on the tailnet: ${url}`);
  }
  await writeState({
    running: true, starting: false, url, localUrl: server.url, port: server.port, display,
    tailscale: plan.tailscale ? { path: prefix, dnsName: plan.dnsName } : null,
    processes: children.map((entry) => ({ label: entry.label, ...entry.process })),
  });

  const idleMs = plan.idleMinutes * 60_000;
  setInterval(() => {
    if (server.viewerCount() === 0 && Date.now() - lastActivity > idleMs) void stop(`idle for ${plan.idleMinutes} min`);
  }, 30_000).unref();
  setInterval(async () => {
    const current = await readJson(paths.manifest).catch(() => null);
    if (!current?.running || current.supervisor?.pid !== manifest.supervisor.pid) void stop('sandbox stopped');
  }, 5_000).unref();
}

try {
  await main();
} catch (error) {
  log(`FAILED: ${error.stack ?? error.message}`);
  if (shareState) await writeState({ startError: error.message }).catch(() => {});
  await stop('startup failure');
}
