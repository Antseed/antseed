import { describe, expect, it } from 'vitest';
import { isCanonicalRequestPath, isUnambiguousDataRequestPath } from '../src/proxy/request-path.js';

describe('isUnambiguousDataRequestPath', () => {
  it.each([
    '/v1/data/flights/airports/New%20York',
    '/v1/data/flights/airports/S%C3%A3o%20Paulo?limit=5',
    '/v1/data/fl%69ghts/search',
    '/v1/data/flights/search/',
    '/v1/data/flights/',
    '/v1/data/flights',
    '/v1/data/flights/search?q=a/../b&next=%2F',
    '/v1/data/flights/notes/100%25',
    '/v1/data/flights/v1.2/file.json',
  ])('passes %s on as sent', (path) => {
    expect(isUnambiguousDataRequestPath(path)).toBe(true);
  });

  it.each([
    ['a dot segment', '/v1/data/flights/../admin'],
    ['a current-directory segment', '/v1/data/flights/./search'],
    ['an encoded dot segment', '/v1/data/flights/%2e%2e/admin'],
    ['a half-encoded dot segment', '/v1/data/flights/.%2E/admin'],
    ['an encoded slash', '/v1/data/flights/a%2Fb'],
    ['an encoded slash in the service', '/v1/data/flights%2F..%2Fadmin/search'],
    ['an encoded backslash', '/v1/data/flights/a%5C..%5Cb'],
    ['a twice-encoded slash', '/v1/data/flights/a%252Fb'],
    ['a twice-encoded dot segment', '/v1/data/flights/%252e%252e/admin'],
    ['an encoded NUL', '/v1/data/flights/search%00.json'],
    ['a malformed escape', '/v1/data/flights/50%'],
    ['an escape with no hex', '/v1/data/flights/%zz'],
    ['an empty segment', '/v1/data/flights//search'],
    ['two trailing slashes', '/v1/data/flights/search//'],
    ['a path parameter', '/v1/data/flights/search;admin'],
    ['a relative path', 'v1/data/flights/search'],
  ])('refuses %s', (_name, path) => {
    expect(isUnambiguousDataRequestPath(path)).toBe(false);
  });

  it('leaves the strict check for every other path unchanged', () => {
    expect(isCanonicalRequestPath('/v1/chat/completions')).toBe(true);
    expect(isCanonicalRequestPath('/v1/chat/completions/')).toBe(false);
    expect(isCanonicalRequestPath('/v1/chat/compl%65tions')).toBe(false);
  });
});
