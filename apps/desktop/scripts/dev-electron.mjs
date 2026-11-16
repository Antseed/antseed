import { spawn } from 'node:child_process';

const port = Number(process.env.ANTSEED_DESKTOP_RENDERER_PORT) || 5174;
let child = spawn('pnpm', [
  'exec',
  'wait-on',
  `tcp:${port}`,
  'file:dist/main/main.js',
  'file:dist/main/preload.cjs',
], { stdio: 'inherit' });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}

child.once('exit', (code, signal) => {
  if (code !== 0) {
    process.exitCode = code ?? (signal ? 1 : 0);
    return;
  }
  // Chromium refuses to run as root on Linux unless its own sandbox is off (servers often run as root).
  const rootArgs = process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : [];
  if (rootArgs.length) console.warn('[dev-electron] running as root on Linux: starting Electron with --no-sandbox');
  child = spawn('pnpm', ['exec', 'electron', '.', ...rootArgs, ...process.argv.slice(2)], {
    env: { ...process.env, VITE_DEV_SERVER_URL: `http://127.0.0.1:${port}` },
    stdio: 'inherit',
  });
  child.once('exit', (electronCode, electronSignal) => {
    process.exitCode = electronCode ?? (electronSignal ? 1 : 0);
  });
});
