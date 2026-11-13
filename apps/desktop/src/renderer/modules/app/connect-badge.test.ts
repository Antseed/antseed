import { describe, expect, it } from 'vitest';
import { deriveConnectBadge } from './connect-badge';
import type { RuntimeProcessState } from '../../types/bridge';

const running: RuntimeProcessState = { mode: 'gateway', running: true, pid: 1, startedAt: 1, lastExitCode: null, lastError: null };
const stopped: RuntimeProcessState = { mode: 'gateway', running: false, pid: null, startedAt: null, lastExitCode: 0, lastError: null };
const errored: RuntimeProcessState = { ...stopped, lastExitCode: 1, lastError: 'boom' };
const reachable = { mode: 'local', reachable: true } as const;
const unreachable = { mode: 'local', reachable: false } as const;

describe('deriveConnectBadge', () => {
  it('is Starting while the process runs but the gateway does not answer', () => {
    expect(deriveConnectBadge([running], unreachable)).toEqual({ tone: 'warn', label: 'Starting...' });
    expect(deriveConnectBadge([running], null)).toEqual({ tone: 'warn', label: 'Starting...' });
  });
  it('is Running once the gateway answers', () => {
    expect(deriveConnectBadge([running], reachable)).toEqual({ tone: 'active', label: 'Running' });
  });
  it('is Stopped (bad tone) with no process or a clean exit', () => {
    expect(deriveConnectBadge([], unreachable)).toEqual({ tone: 'bad', label: 'Stopped' });
    expect(deriveConnectBadge([stopped], reachable)).toEqual({ tone: 'bad', label: 'Stopped' });
  });
  it('is Error after a failed exit', () => {
    expect(deriveConnectBadge([errored], unreachable)).toEqual({ tone: 'warn', label: 'Error' });
  });
  it('follows only the health probe for a remote gateway, which has no local process', () => {
    expect(deriveConnectBadge([], { mode: 'remote', reachable: true })).toEqual({ tone: 'active', label: 'Running' });
    expect(deriveConnectBadge([], { mode: 'remote', reachable: false })).toEqual({ tone: 'warn', label: 'Unreachable' });
  });
});
