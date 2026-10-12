import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { fetchPublicJson } from '../src/reputation/public-json.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));

describe('pinned public JSON transport', () => {
  beforeEach(() => {
    vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
  });
  afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

  function respond(statusCode: number, body: string) {
    vi.mocked(request).mockImplementation(((_url: unknown, options: Record<string, any>, callback: (response: unknown) => void) => {
      const response = Object.assign(new PassThrough(), { statusCode, headers: {} });
      const req = Object.assign(new EventEmitter(), { end: () => {
        callback(response);
        response.end(body);
      } });
      options.signal.addEventListener('abort', () => req.emit('error', new Error('aborted')));
      return req;
    }) as never);
  }

  it('pins the checked address, preserving TLS hostname without a second DNS resolution', async () => {
    respond(200, '{"ok":true}');
    expect(await fetchPublicJson('https://api.github.com/test')).toEqual({ ok: true });
    expect(lookup).toHaveBeenCalledTimes(1);
    const options = vi.mocked(request).mock.calls[0]![1] as any;
    const callback = vi.fn();
    options.lookup('api.github.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    expect(options.family).toBe(4);
  });

  it('rejects a mixed public/private DNS answer without connecting', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] as never);
    await expect(fetchPublicJson('https://registry.example/test')).rejects.toThrow('Non-public');
    expect(request).not.toHaveBeenCalled();
  });

  it('never follows redirects', async () => {
    respond(302, '');
    await expect(fetchPublicJson('https://registry.example/test')).rejects.toThrow('HTTP 302');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('bounds streaming response size', async () => {
    respond(200, 'x'.repeat(101));
    await expect(fetchPublicJson('https://registry.example/test', { maxBytes: 100 })).rejects.toThrow('too large');
  });

  it('times out DNS and does not connect after late resolution', async () => {
    vi.useFakeTimers();
    let resolveDns!: (value: unknown) => void;
    vi.mocked(lookup).mockReturnValue(new Promise((resolve) => { resolveDns = resolve; }) as never);
    const pending = expect(fetchPublicJson('https://registry.example/test')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(8_001);
    await pending;
    resolveDns([{ address: '8.8.8.8', family: 4 }]);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
  });
});
