import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isolatedEnv } from './env.mjs';
import { isInside } from './paths.mjs';

export const MOCK_REPLY = /Hello from sandbox seller/;

/** Environment for an attach-only desktop on the sandbox buyer; all desktop state stays in the sandbox dir. */
export function desktopEnv({ manifest, instance, ports, baseEnv = process.env, stateDir = 'desktop-automation' }) {
  const instanceDir = join(manifest.dir, stateDir);
  const env = isolatedEnv(baseEnv, baseEnv.HOME ?? manifest.home, {
    ANTSEED_DESKTOP_ATTACH_ONLY: '1',
    ANTSEED_CONFIG_PATH: manifest.buyerConfig,
    ANTSEED_DESKTOP_CONNECT_DATA_DIR: manifest.buyerDir,
    ANTSEED_PROXY_URL: manifest.proxyUrl,
    ANTSEED_BASE_RPC_URL: manifest.rpcUrl,
    ANTSEED_DESKTOP_INSTANCE: instance,
    ANTSEED_DESKTOP_MULTI_INSTANCE: '1',
    ANTSEED_DESKTOP_USER_DATA_DIR: join(instanceDir, 'electron'),
    ANTSEED_SYSTEM_PROXY_DATA_DIR: join(instanceDir, 'system-proxy'),
    ANTSEED_PAYMENTS_PORT: String(ports.payments),
    ANTSEED_SYSTEM_PROXY_PORT: String(ports.systemProxy),
    TELEMETRY_ENABLED: '0',
  });
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

  const executablePath = createRequire(join(desktopDir, 'package.json'))('electron');
  const app = await electron.launch({
    executablePath, args: ['.'], cwd: desktopDir, env, timeout: 60_000,
    recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
  });
  if (trace) await app.context().tracing.start({ screenshots: true, snapshots: true, title });
  const mainLog = createWriteStream(join(reportDir, 'desktop-main.log'), { flags: 'a' });
  app.process().stdout?.pipe(mainLog, { end: false });
  app.process().stderr?.pipe(mainLog, { end: false });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('button', { name: 'Chat', exact: true }).waitFor({ timeout: 60_000 });
  await event('desktop-launched', { instance });

  let shot = 0;
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
      const tracePath = join(reportDir, 'trace.zip');
      if (trace) await app.context().tracing.stop({ path: tracePath }).catch(() => {});
      const video = page.video();
      await app.close().catch(() => {});
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
