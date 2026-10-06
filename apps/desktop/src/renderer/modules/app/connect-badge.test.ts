import { describe, expect, it } from 'vitest';
import { deriveConnectBadge, isBuyerReady } from './connect-badge';
import type { RuntimeProcessState } from '../../types/bridge';

const running: RuntimeProcessState = { mode: 'connect', running: true, pid: 1, startedAt: 1, lastExitCode: null, lastError: null };
const stopped: RuntimeProcessState = { mode: 'connect', running: false, pid: null, startedAt: null, lastExitCode: 0, lastError: null };
const errored: RuntimeProcessState = { ...stopped, lastExitCode: 1, lastError: 'boom' };

describe('deriveConnectBadge', () => {
  it('is Starting while the process runs but the proxy port is closed', () => {
    expect(deriveConnectBadge([running], false)).toEqual({ tone: 'warn', label: 'Starting...' });
  });
  it('is Running once the proxy is reachable', () => {
    expect(deriveConnectBadge([running], true)).toEqual({ tone: 'active', label: 'Running' });
  });
  it('is Stopped (bad tone) with no process or a clean exit', () => {
    expect(deriveConnectBadge([], false)).toEqual({ tone: 'bad', label: 'Stopped' });
    expect(deriveConnectBadge([stopped], true)).toEqual({ tone: 'bad', label: 'Stopped' });
  });
  it('is Error after a failed exit', () => {
    expect(deriveConnectBadge([errored], false)).toEqual({ tone: 'warn', label: 'Error' });
  });
});

describe('isBuyerReady', () => {
  it('needs both a running process and a reachable proxy', () => {
    expect(isBuyerReady([running], true)).toBe(true);
    expect(isBuyerReady([running], false)).toBe(false);
    expect(isBuyerReady([stopped], true)).toBe(false);
  });
});
