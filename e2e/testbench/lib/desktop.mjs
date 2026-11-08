import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isolatedEnv, toolchainEnv } from './env.mjs';
import { isInside } from './paths.mjs';

export const MOCK_REPLY = /Hello from testbench seller/;

/**
 * Environment every attach-only desktop shares. HOME is the testbench's own home/, never yours, so nothing in the
 * desktop can read your ~/.antseed (wallets, tunnel and Telegram settings, plugins) or reach your login keychain:
 * the app uses a mock keychain in attach-only mode. The wallet is the testbench buyer's, read from its data dir.
 */
export function attachOnlyEnv({ manifest, baseEnv = process.env, extra = {}, platform = process.platform }) {
  assertAttachOnlyPlatform(platform);
  return isolatedEnv(baseEnv, manifest.home, {
    ...toolchainEnv(baseEnv),
    ANTSEED_DESKTOP_ATTACH_ONLY: '1',
    ANTSEED_CONFIG_PATH: manifest.buyerConfig,
    ANTSEED_DESKTOP_CONNECT_DATA_DIR: manifest.buyerDir,
    ANTSEED_PROXY_URL: manifest.proxyUrl,
    ANTSEED_BASE_RPC_URL: manifest.rpcUrl,
    ...extra,
  });
}

/**
 * The attach-only desktop is isolated through HOME. Windows resolves the home directory from USERPROFILE and APPDATA
 * instead, so there the desktop would read the real ~/.antseed. Same reason the full isolated profile is refused.
 */
export function assertAttachOnlyPlatform(platform = process.platform) {
  if (platform === 'win32') {
    throw new Error('The attach-only desktop (pnpm testbench desktop, desktop scenarios, share) is not supported on Windows: it is isolated through HOME, but Windows reads the home directory from USERPROFILE and APPDATA, so the desktop would read your real ~/.antseed (wallet, tunnel and Telegram settings). Run it on macOS or Linux');
  }
}

/** Environment for an attach-only desktop on the testbench buyer; all desktop state stays in the testbench dir. */
export function desktopEnv({ manifest, instance, ports, baseEnv = process.env, stateDir = 'desktop-automation' }) {
  const instanceDir = join(manifest.dir, stateDir);
  const env = attachOnlyEnv({ manifest, baseEnv, extra: {
    ANTSEED_DESKTOP_INSTANCE: instance,
    ANTSEED_DESKTOP_MULTI_INSTANCE: '1',
    ANTSEED_DESKTOP_USER_DATA_DIR: join(instanceDir, 'electron'),
    ANTSEED_SYSTEM_PROXY_DATA_DIR: join(instanceDir, 'system-proxy'),
    ANTSEED_PAYMENTS_PORT: String(ports.payments),
    ANTSEED_SYSTEM_PROXY_PORT: String(ports.systemProxy),
    TELEMETRY_ENABLED: '0',
  } });
  delete env.VITE_DEV_SERVER_URL;
  return env;
}

function assertDesktopBuilt(desktopDir) {
  for (const file of ['dist/main/main.js', 'dist/renderer/index.html']) {
    if (!existsSync(join(desktopDir, file))) {
      throw new Error(`Desktop is not built (missing apps/desktop/${file}); run pnpm --filter @antseed/desktop run build:main && pnpm --filter @antseed/desktop run build:renderer`);
    }
  }
}

/**
 * Launches the built attach-only desktop under Playwright. Screenshots and the main-process
 * log go to the report directory.
 */
export async function launchDesktop({ repo, manifest, reportDir, event = async () => {}, trace = false }) {
  const desktopDir = join(repo, 'apps/desktop');
  assertDesktopBuilt(desktopDir);
  const { resolveInstancePorts } = await import(pathToFileURL(join(desktopDir, 'scripts/dev-instance-config.mjs')).href);
  const instance = `${manifest.desktopInstance ?? manifest.name}-pw`.slice(0, 48);
  const automationDir = join(manifest.dir, 'desktop-automation');
  if (!isInside(automationDir, manifest.dir)) throw new Error(`Refusing to reset ${automationDir}`);
  await rm(automationDir, { recursive: true, force: true });
  const env = desktopEnv({ manifest, instance, ports: resolveInstancePorts(instance) });
  return launchElectron({ desktopDir, env, reportDir, event, trace, instance, title: manifest.name });
}

/** Launches the built full desktop (its own buyer) on a prepared profile environment; see lib/mainnet.mjs. */
export async function launchProfileDesktop({ repo, env, instance, reportDir, event = async () => {}, trace = false }) {
  const desktopDir = join(repo, 'apps/desktop');
  assertDesktopBuilt(desktopDir);
  return launchElectron({ desktopDir, env, reportDir, event, trace, instance, title: instance });
}

export const FFMPEG_INSTALL = 'pnpm exec playwright install ffmpeg';

/**
 * Playwright records desktop video with its own ffmpeg build, a separate download. Without it the Electron
 * window never finishes loading and a desktop scenario only times out, so check before launching.
 * Read-only: asks Playwright where that ffmpeg belongs (`install --dry-run`) and looks for it there.
 */
export function playwrightFfmpeg({ env = process.env } = {}) {
  let cli;
  try {
    cli = join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
  } catch {
    return { installed: false, location: null, reason: 'Playwright is not installed; run pnpm install' };
  }
  const result = spawnSync(process.execPath, [cli, 'install', '--dry-run', 'ffmpeg'], { encoding: 'utf8', env, timeout: 30_000 });
  const location = /Install location:\s*(.+)/.exec(result.stdout ?? '')?.[1]?.trim() ?? null;
  if (!location) return { installed: false, location: null, reason: 'could not ask Playwright where ffmpeg belongs' };
  const installed = existsSync(location) && readdirSync(location).some((name) => name.startsWith('ffmpeg'));
  return { installed, location, reason: installed ? null : `Playwright's ffmpeg is not installed (expected in ${location})` };
}

/** Electron on Linux refuses to start as root unless Chromium's own sandbox is turned off. */
export function electronRootArgs({ platform = process.platform, uid = process.getuid?.() } = {}) {
  return platform === 'linux' && uid === 0 ? ['--no-sandbox'] : [];
}

/** Closes the app, and kills its process if Electron does not exit in time (it can hang on shutdown). */
export async function closeApp(app, { timeoutMs = 15_000 } = {}) {
  let child = null;
  try { child = app.process(); } catch { return; /* already closed: Playwright has dropped the app */ }
  const exited = new Promise((resolveExit) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) resolveExit();
    else child.once('exit', () => resolveExit());
  });
  const timer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* already gone */ } }, timeoutMs);
  try {
    // app.close() can wait forever on a hung Electron; the process exiting (or being killed) ends it too.
    await Promise.race([app.close().catch(() => {}), exited]);
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

async function launchElectron({ desktopDir, env, reportDir, event, trace, instance, title }) {
  let electron;
  try {
    ({ _electron: electron } = await import('playwright'));
  } catch {
    throw new Error('Playwright is not installed; run pnpm install');
  }
  const shotsDir = join(reportDir, 'screenshots');
  const videoDir = join(reportDir, 'video');
  await mkdir(shotsDir, { recursive: true, mode: 0o700 });
  await mkdir(videoDir, { recursive: true, mode: 0o700 });

  const ffmpeg = playwrightFfmpeg();
  if (!ffmpeg.installed) throw new Error(`${ffmpeg.reason}. Desktop scenarios record video with it; run once: ${FFMPEG_INSTALL}`);
  const executablePath = createRequire(join(desktopDir, 'package.json'))('electron');
  const app = await electron.launch({
    executablePath, args: ['.'], cwd: desktopDir, env, timeout: 60_000,
    recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
  });
  if (trace) await app.context().tracing.start({ screenshots: true, snapshots: true, title });
  const mainLog = createWriteStream(join(reportDir, 'desktop-main.log'), { flags: 'a' });
  app.process().stdout?.pipe(mainLog, { end: false });
  app.process().stderr?.pipe(mainLog, { end: false });
  const errors = [];
  let page;
  try {
    page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: 'Chat', exact: true }).waitFor({ timeout: 60_000 });
  } catch (error) {
    // Nobody holds the app yet, so a failed launch must close it here or it outlives the run.
    await closeApp(app);
    mainLog.end();
    throw error;
  }
  await event('desktop-launched', { instance });

  let shot = 0;
  let closed = false;
  const ui = {
    app,
    page,
    errors,
    async screenshot(name) {
      shot += 1;
      const path = join(shotsDir, `${String(shot).padStart(2, '0')}-${name.replace(/[^a-z0-9-]+/gi, '-')}.png`);
      await page.screenshot({ path });
      await event('desktop-screenshot', { name, path });
      return path;
    },
    text: () => page.evaluate(() => document.body.innerText),
    async openChat() {
      await page.getByRole('button', { name: 'Chat', exact: true }).click();
      await page.locator('textarea').first().waitFor({ timeout: 30_000 });
    },
    /** Types a prompt into the composer, sends it, and waits for a reply matching `expect` after it. */
    async sendChat(prompt, { expect = MOCK_REPLY, acceptLowReputation = true, timeoutMs = 60_000 } = {}) {
      await ui.openChat();
      const started = Date.now();
      await page.locator('textarea').first().fill(prompt);
      await page.getByRole('button', { name: 'Send message' }).click();
      const proceed = page.getByRole('button', { name: 'Continue anyway' });
      while (Date.now() < started + timeoutMs) {
        if (acceptLowReputation && await proceed.isVisible().catch(() => false)) {
          await proceed.click().catch(() => {});
          await event('desktop-accepted-low-reputation', {});
        }
        const body = await ui.text();
        const at = body.lastIndexOf(prompt);
        const match = at >= 0 ? body.slice(at + prompt.length).match(expect) : null;
        if (match) {
          const after = body.slice(at + prompt.length);
          const result = { prompt, reply: after.slice(match.index).split('\n')[0].trim(), latencyMs: Date.now() - started };
          await event('desktop-chat', result);
          return result;
        }
        await page.waitForTimeout(250);
      }
      const shotPath = await ui.screenshot('chat-timeout').catch(() => null);
      const tail = (await ui.text().catch(() => '')).replace(/\s+/g, ' ').slice(-1200);
      throw new Error(`No reply matching ${expect} within ${timeoutMs}ms after sending "${prompt}". Screen ends with: ${tail}${shotPath ? ` (screenshot ${shotPath})` : ''}`);
    },
    async close() {
      // Scenarios may close the desktop themselves; dispose() closes it again.
      if (closed) return;
      closed = true;
      const tracePath = join(reportDir, 'trace.zip');
      if (trace) await app.context().tracing.stop({ path: tracePath }).catch(() => {});
      const video = page.video();
      await closeApp(app);
      let videoPath = null;
      if (video) {
        const recorded = await video.path().catch(() => null);
        if (recorded && existsSync(recorded)) {
          videoPath = join(videoDir, 'desktop.webm');
          await rename(recorded, videoPath);
        }
      }
      for (const name of await readdir(videoDir).catch(() => [])) {
        if (name !== 'desktop.webm') await rm(join(videoDir, name), { force: true });
      }
      mainLog.end();
      await event('desktop-closed', { rendererErrors: errors.length, video: videoPath, trace: existsSync(tracePath) ? tracePath : null });
    },
  };
  return ui;
}
