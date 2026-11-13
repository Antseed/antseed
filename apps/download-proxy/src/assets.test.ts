import {describe, expect, it} from 'vitest';
import {matchAsset, parseTarget} from './assets';

// Real asset names from the v0.2.14 release.
const RELEASE_ASSETS = [
  'AntSeed-VPR-0.2.14-amd64.deb',
  'AntSeed-VPR-0.2.14-arm64-mac.zip',
  'AntSeed-VPR-0.2.14-arm64.AppImage',
  'AntSeed-VPR-0.2.14-arm64.deb',
  'AntSeed-VPR-0.2.14-arm64.dmg',
  'AntSeed-VPR-0.2.14-arm64.dmg.blockmap',
  'AntSeed-VPR-0.2.14-mac.zip',
  'AntSeed-VPR-0.2.14-x86_64.AppImage',
  'AntSeed-VPR-0.2.14.dmg',
  'AntSeed-VPR-0.2.14.dmg.blockmap',
  'AntSeed-VPR-Setup-0.2.14.exe',
  'AntSeed-VPR-Setup-0.2.14.exe.blockmap',
  'latest-linux.yml',
  'latest-mac.yml',
  'latest.yml',
].map(name => ({name}));

describe('parseTarget', () => {
  it('accepts every platform-arch pair', () => {
    expect(parseTarget('mac-arm64')).toEqual({platform: 'mac', arch: 'arm64'});
    expect(parseTarget('mac-x64')).toEqual({platform: 'mac', arch: 'x64'});
    expect(parseTarget('win-x64')).toEqual({platform: 'win', arch: 'x64'});
    expect(parseTarget('win-arm64')).toEqual({platform: 'win', arch: 'arm64'});
    expect(parseTarget('linux-x64')).toEqual({platform: 'linux', arch: 'x64'});
    expect(parseTarget('linux-arm64')).toEqual({platform: 'linux', arch: 'arm64'});
  });

  it('rejects malformed segments', () => {
    expect(parseTarget('mac')).toBeNull();
    expect(parseTarget('mac-arm')).toBeNull();
    expect(parseTarget('windows-x64')).toBeNull();
    expect(parseTarget('mac-arm64-extra')).toBeNull();
    expect(parseTarget('')).toBeNull();
  });
});

describe('matchAsset', () => {
  it('matches the mac dmg per arch, never the updater zip or blockmap', () => {
    expect(matchAsset(RELEASE_ASSETS, {platform: 'mac', arch: 'arm64'})?.name).toBe(
      'AntSeed-VPR-0.2.14-arm64.dmg',
    );
    expect(matchAsset(RELEASE_ASSETS, {platform: 'mac', arch: 'x64'})?.name).toBe(
      'AntSeed-VPR-0.2.14.dmg',
    );
  });

  it('matches the windows installer', () => {
    expect(matchAsset(RELEASE_ASSETS, {platform: 'win', arch: 'x64'})?.name).toBe(
      'AntSeed-VPR-Setup-0.2.14.exe',
    );
    // No arm64 exe published — must not fall back to the x64 one.
    expect(matchAsset(RELEASE_ASSETS, {platform: 'win', arch: 'arm64'})).toBeNull();
  });

  it('matches the AppImage per arch, ignoring debs', () => {
    expect(matchAsset(RELEASE_ASSETS, {platform: 'linux', arch: 'x64'})?.name).toBe(
      'AntSeed-VPR-0.2.14-x86_64.AppImage',
    );
    expect(matchAsset(RELEASE_ASSETS, {platform: 'linux', arch: 'arm64'})?.name).toBe(
      'AntSeed-VPR-0.2.14-arm64.AppImage',
    );
  });

  it('returns null when the asset list is empty', () => {
    expect(matchAsset([], {platform: 'mac', arch: 'arm64'})).toBeNull();
  });
});
