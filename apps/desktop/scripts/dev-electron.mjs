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
  const cdpPort = process.env.ANTSEED_DESKTOP_CDP_PORT;
  const cdpArgs = cdpPort ? [`--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1'] : [];
  child = spawn('pnpm', ['exec', 'electron', '.', ...cdpArgs, ...process.argv.slice(2)], {
    env: { ...process.env, VITE_DEV_SERVER_URL: `http://127.0.0.1:${port}` },
    stdio: 'inherit',
  });
  child.once('exit', (electronCode, electronSignal) => {
    process.exitCode = electronCode ?? (electronSignal ? 1 : 0);
  });
});
