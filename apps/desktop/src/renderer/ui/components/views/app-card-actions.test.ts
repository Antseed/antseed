import { expect, it } from 'vitest';
import { offersConnectAnyway } from './app-card-actions';

it('keeps Connect for a seemingly missing tool on Windows, where it may be inside WSL', () => {
  expect(offersConnectAnyway('win32')).toBe(true);
  expect(offersConnectAnyway('darwin')).toBe(false);
  expect(offersConnectAnyway('linux')).toBe(false);
  expect(offersConnectAnyway(undefined)).toBe(false);
});
