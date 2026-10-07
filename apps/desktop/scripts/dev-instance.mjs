import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveInstancePorts } from './dev-instance-config.mjs';

const instanceName = process.argv.slice(2).find((arg) => arg !== '--') ?? 'status';
const ports = resolveInstancePorts(instanceName);
const instanceDir = path.join(tmpdir(), 'antseed-desktop', instanceName);
const child = spawn('pnpm', ['run', 'dev'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ANTSEED_DESKTOP_INSTANCE: instanceName,
    ANTSEED_DESKTOP_MULTI_INSTANCE: '1',
    ANTSEED_DESKTOP_RENDERER_PORT: String(ports.renderer),
    ANTSEED_DESKTOP_USER_DATA_DIR: path.join(instanceDir, 'electron'),
    ANTSEED_PAYMENTS_PORT: String(ports.payments),
    ANTSEED_SYSTEM_PROXY_PORT: String(ports.systemProxy),
    ANTSEED_SYSTEM_PROXY_DATA_DIR: path.join(instanceDir, 'system-proxy'),
  },
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
