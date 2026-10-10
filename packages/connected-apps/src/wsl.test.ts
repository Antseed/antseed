import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  clearWslTargetsForTool,
  decodeWslOutput,
  discoverWslToolTargets,
  isMappablePosixPath,
  parseDefaultRouteGateway,
  parseWslDistroList,
  readWslTargets,
  readWslTargetsForTool,
  saveWslTargetsForTool,
  wslToolProbeCommand,
  wslUncPath,
  type WslConfigTarget,
} from './wsl.js';

function utf16(text: string): Buffer {
  return Buffer.from(`\uFEFF${text}`, 'utf16le');
}

test('decodeWslOutput handles UTF-16LE with BOM and plain UTF-8', () => {
  assert.equal(decodeWslOutput(utf16('Ubuntu\r\n')), 'Ubuntu\r\n');
  assert.equal(decodeWslOutput(Buffer.from('Ubuntu\n', 'utf8')), 'Ubuntu\n');
});

test('parseWslDistroList drops blanks and utility distros', () => {
  const distros = parseWslDistroList(utf16('Ubuntu\r\ndocker-desktop\r\nDebian\r\ndocker-desktop-data\r\n\r\n'));
  assert.deepEqual(distros, ['Ubuntu', 'Debian']);
});

test('parseDefaultRouteGateway extracts the NAT gateway address', () => {
  assert.equal(
    parseDefaultRouteGateway('default via 172.29.32.1 dev eth0 proto kernel\n'),
    '172.29.32.1',
  );
  assert.equal(parseDefaultRouteGateway(''), null);
  assert.equal(parseDefaultRouteGateway('default dev eth0 scope link\n'), null);
});

test('wslUncPath maps a POSIX path into the distro share', () => {
  assert.equal(
    wslUncPath('Ubuntu', '/home/user/.config/opencode/opencode.jsonc'),
    '\\\\wsl.localhost\\Ubuntu\\home\\user\\.config\\opencode\\opencode.jsonc',
  );
  assert.equal(
    wslUncPath('Debian', '/root/.config/opencode/opencode.jsonc', '\\\\wsl$'),
    '\\\\wsl$\\Debian\\root\\.config\\opencode\\opencode.jsonc',
  );
});

test('wslToolProbeCommand checks the binary and every home-relative signal', () => {
  const command = wslToolProbeCommand('opencode');
  assert.ok(command.startsWith('command -v opencode >/dev/null 2>&1'));
  assert.ok(command.includes('test -e "$HOME/.opencode/bin/opencode"'));
  assert.ok(command.includes('test -e "$HOME/.local/share/opencode"'));
  assert.ok(wslToolProbeCommand('codex').includes('test -e "$HOME/.codex"'));
  assert.ok(wslToolProbeCommand('droid').includes('test -e "$HOME/.factory"'));
});

test('WSL targets file keeps per-tool rows independent and clears when empty', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'antseed-wsl-targets-'));
  try {
    const filePath = path.join(dir, 'system-proxy.wsl-targets.json');
    const opencodeTargets: WslConfigTarget[] = [
      { tool: 'opencode', distro: 'Ubuntu', configPath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\x.jsonc', host: '172.29.32.1', needsRelay: true },
      { tool: 'opencode', distro: 'Mirrored', configPath: '\\\\wsl.localhost\\Mirrored\\home\\u\\x.jsonc', host: 'localhost', needsRelay: false },
    ];
    const piTargets: WslConfigTarget[] = [
      { tool: 'pi', distro: 'Ubuntu', configPath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\models.json', settingsPath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\settings.json', host: '172.29.32.1', needsRelay: true },
    ];
    saveWslTargetsForTool(filePath, 'opencode', opencodeTargets);
    saveWslTargetsForTool(filePath, 'pi', piTargets);
    assert.deepEqual(readWslTargets(filePath), [...opencodeTargets, ...piTargets]);
    assert.deepEqual(readWslTargetsForTool(filePath, 'pi'), piTargets);

    // Re-saving one tool replaces only that tool's rows.
    saveWslTargetsForTool(filePath, 'opencode', [opencodeTargets[0]!]);
    assert.deepEqual(readWslTargets(filePath), [piTargets[0], opencodeTargets[0]]);

    clearWslTargetsForTool(filePath, 'opencode');
    assert.deepEqual(readWslTargets(filePath), piTargets);

    // Clearing the last tool removes the file entirely.
    clearWslTargetsForTool(filePath, 'pi');
    assert.equal(existsSync(filePath), false);
    assert.deepEqual(readWslTargets(filePath), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('isMappablePosixPath rejects Windows known-folder paths', () => {
  assert.equal(isMappablePosixPath('~/.config/crush/crush.json'), true);
  assert.equal(isMappablePosixPath('/root/.config/goose/config.yaml'), true);
  assert.equal(isMappablePosixPath('C:\\Users\\u\\AppData\\Local\\crush\\crush.json'), false);
  // A profile with installProbe but no wslConfigPath falls back to its
  // Windows-resolved configPath; discovery must refuse to map that.
  assert.deepEqual(
    discoverWslToolTargets('crush', { configPath: 'C:\\Users\\u\\AppData\\Local\\crush\\crush.json' }),
    [],
  );
});
