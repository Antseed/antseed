import test from 'node:test';
import assert from 'node:assert/strict';
import { isWindowsProxyPointingAt, parseRegQueryValue, windowsProxyRestoreWrites } from './legacy-windows-proxy-state.js';

const REG_OUTPUT = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
  '    ProxyEnable    REG_DWORD    0x1',
  '    ProxyServer    REG_SZ    127.0.0.1:8378',
  '',
].join('\r\n');

test('parses a REG_DWORD value out of reg query output', () => {
  assert.equal(parseRegQueryValue(REG_OUTPUT, 'ProxyEnable'), '0x1');
});

test('parses a REG_SZ value out of reg query output', () => {
  assert.equal(parseRegQueryValue(REG_OUTPUT, 'ProxyServer'), '127.0.0.1:8378');
});

test('a missing value reads as null rather than throwing', () => {
  assert.equal(parseRegQueryValue(REG_OUTPUT, 'ProxyOverride'), null);
});

test('a name prefix does not match a longer value name', () => {
  assert.equal(parseRegQueryValue(REG_OUTPUT, 'Proxy'), null);
});

test('value names match case-insensitively, as the registry does', () => {
  assert.equal(parseRegQueryValue(REG_OUTPUT, 'proxyenable'), '0x1');
});

test('proxy pointing at our port on the current setting is configured', () => {
  assert.equal(isWindowsProxyPointingAt('0x1', '127.0.0.1:8378', 8378), true);
  assert.equal(isWindowsProxyPointingAt('0x1', 'localhost:8378', 8378), true);
});

test('a per-protocol proxy list still matches the endpoint', () => {
  assert.equal(
    isWindowsProxyPointingAt('0x1', 'http=127.0.0.1:8378;https=127.0.0.1:8378', 8378),
    true,
  );
});

// The silent-failure cases this check exists to catch.
test('a disabled proxy is not configured even when the server still names us', () => {
  assert.equal(isWindowsProxyPointingAt('0x0', '127.0.0.1:8378', 8378), false);
});

test('another tool overwriting the server reads as not configured', () => {
  assert.equal(isWindowsProxyPointingAt('0x1', '10.0.0.1:3128', 8378), false);
});

test('a proxy on a different local port is not ours', () => {
  assert.equal(isWindowsProxyPointingAt('0x1', '127.0.0.1:9999', 8378), false);
});

test('a port merely starting with ours is not ours', () => {
  assert.equal(isWindowsProxyPointingAt('0x1', '127.0.0.1:83781', 8378), false);
  assert.equal(isWindowsProxyPointingAt('0x1', 'http=127.0.0.1:83781', 8378), false);
});

test('missing registry values read as not configured', () => {
  assert.equal(isWindowsProxyPointingAt(null, null, 8378), false);
  assert.equal(isWindowsProxyPointingAt('0x1', null, 8378), false);
});

test('a snapshot restores every value it captured', () => {
  assert.deepEqual(
    windowsProxyRestoreWrites({
      platform: 'win32',
      proxyEnable: '0x1',
      proxyServer: '10.0.0.1:3128',
      proxyOverride: '<local>',
    }),
    [
      { name: 'ProxyEnable', type: 'REG_DWORD', value: '0x1' },
      { name: 'ProxyServer', type: 'REG_SZ', value: '10.0.0.1:3128' },
      { name: 'ProxyOverride', type: 'REG_SZ', value: '<local>' },
    ],
  );
});

test('a value that was unset before is deleted, not written empty', () => {
  assert.deepEqual(
    windowsProxyRestoreWrites({ platform: 'win32', proxyEnable: '0x0', proxyServer: null, proxyOverride: null }),
    [
      { name: 'ProxyEnable', type: 'REG_DWORD', value: '0x0' },
      { name: 'ProxyServer', type: 'delete' },
      { name: 'ProxyOverride', type: 'delete' },
    ],
  );
});

// The silent-damage case: snapshots written before the bypass list existed
// carry no proxyOverride key, and we never wrote one for them either. Treating
// that absence as "was unset" would delete a bypass list the user never asked
// us to touch.
test('a snapshot from before the bypass list leaves ProxyOverride alone', () => {
  assert.deepEqual(
    windowsProxyRestoreWrites({ platform: 'win32', proxyEnable: '0x0', proxyServer: null }),
    [
      { name: 'ProxyEnable', type: 'REG_DWORD', value: '0x0' },
      { name: 'ProxyServer', type: 'delete' },
    ],
  );
});

// Restoring is the fail-open path, so an unreadable snapshot must land on
// "proxy off" rather than leaving the machine pointing at a dead port.
test('an unreadable ProxyEnable restores the proxy to off', () => {
  assert.deepEqual(
    windowsProxyRestoreWrites({ platform: 'win32', proxyEnable: 42, proxyServer: null })[0],
    { name: 'ProxyEnable', type: 'REG_DWORD', value: '0' },
  );
});
