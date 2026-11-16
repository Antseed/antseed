import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function selectInstallerConfig(platform, args) {
  const flags = args.map((argument) => argument.split('=')[0]);
  const linux = flags.some((argument) => ['--linux', '-l'].includes(argument));
  const otherPlatform = flags.some((argument) => ['--mac', '-m', '--macos', '--osx', '-o', '--win', '-w', '--windows'].includes(argument));
  if (linux && otherPlatform) {
    throw new Error('Build Linux separately from macOS/Windows to preserve platform installation identities.');
  }
  return linux || (!otherPlatform && platform === 'linux') ? 'electron-builder.linux.cjs' : 'electron-builder.yml';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  execFileSync(process.execPath, [
    require.resolve('electron-builder/cli.js'),
    '--config', path.join(desktopDir, selectInstallerConfig(process.platform, args)),
    ...args,
  ], { cwd: desktopDir, stdio: 'inherit' });
}
