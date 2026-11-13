import { afterEach, expect, it, vi } from 'vitest';
import { captureToken } from './api';
import { parseRoute } from './router';

afterEach(() => vi.unstubAllGlobals());
it.each(['stake', 'rewards'])('preserves the %s destination while removing the launch token', page => {
  const setItem = vi.fn();
  const replaceState = vi.fn();
  vi.stubGlobal('window', { location: { hash: `#token=test-session&page=${page}`, pathname: '/', search: '' }, sessionStorage: { setItem }, history: { replaceState } });
  captureToken();
  expect(setItem).toHaveBeenCalledWith('ants.dashboard.token', 'test-session');
  expect(replaceState).toHaveBeenCalledWith(null, '', `/#/${page}`);
  expect(parseRoute(`#/${page}`).page).toBe(page);
});
it.each(['#token=test-session', '#token=test-session&page=https://untrusted.example', '#token=test-session&page=unknown'])('defaults old or invalid launch destinations to stake: %s', hash => {
  const replaceState = vi.fn();
  vi.stubGlobal('window', { location: { hash, pathname: '/', search: '' }, sessionStorage: { setItem: vi.fn() }, history: { replaceState } });
  captureToken();
  expect(replaceState).toHaveBeenCalledWith(null, '', '/#/stake');
});
it('leaves an authenticated refresh on Rewards alone', () => {
  const replaceState = vi.fn();
  vi.stubGlobal('window', { location: { hash: '#/rewards' }, history: { replaceState } });
  captureToken();
  expect(replaceState).not.toHaveBeenCalled();
});
