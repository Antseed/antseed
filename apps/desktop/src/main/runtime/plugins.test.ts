import test from 'node:test';
import assert from 'node:assert/strict';

import { windowsNpmInvocation } from './plugins.js';

const nodejs = 'C:\\Program Files\\nodejs';
const cli = `${nodejs}\\node_modules\\npm\\bin\\npm-cli.js`;

test('a Windows npm.cmd runs as its node.exe and npm-cli.js, never the .cmd itself', () => {
  const files = new Set([`${nodejs}\\npm.cmd`, `${nodejs}\\node.exe`, cli]);
  assert.deepEqual(windowsNpmInvocation(`${nodejs}\\npm.cmd`, (file) => files.has(file)), { bin: `${nodejs}\\node.exe`, leadingArgs: [cli] });
});

test('an npm.cmd without node.exe beside it runs npm-cli.js on this runtime; without npm-cli.js, through a shell', () => {
  const global = 'C:\\Users\\a\\AppData\\Roaming\\npm';
  const globalCli = `${global}\\node_modules\\npm\\bin\\npm-cli.js`;
  const viaRuntime = windowsNpmInvocation(`${global}\\npm.cmd`, (file) => file === globalCli);
  assert.equal(viaRuntime.bin, process.execPath);
  assert.deepEqual(viaRuntime.leadingArgs, [globalCli]);
  assert.deepEqual(windowsNpmInvocation(`${global}\\npm.cmd`, () => false), { bin: `${global}\\npm.cmd`, leadingArgs: [], shell: true });
});
