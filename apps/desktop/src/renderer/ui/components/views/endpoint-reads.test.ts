import { describe, expect, it } from 'vitest';
import type { GatewayEndpointInfo } from '../../../types/bridge';
import { copyFreshKey, createEndpointReads, readKeyToCopy } from './endpoint-reads';

const ok = (apiKey: string): GatewayEndpointInfo => ({ ok: true, baseUrl: 'http://127.0.0.1:8379/v1', origin: 'http://127.0.0.1:8379', apiKey, mode: 'local' });

describe('createEndpointReads', () => {
  it('reads the key again on every opening, so a key rotated in the console is never offered', async () => {
    const answers = [ok('sk-old'), ok('sk-new')];
    const shown: Array<GatewayEndpointInfo | null> = [];
    const reads = createEndpointReads(async () => answers.shift()!, (endpoint) => shown.push(endpoint));
    await reads.refresh();
    reads.close();
    await reads.refresh();
    expect(shown.at(-1)).toEqual(ok('sk-new'));
  });

  it('a failed read leaves no earlier key to copy', async () => {
    let fail = false;
    const shown: Array<GatewayEndpointInfo | null> = [];
    const reads = createEndpointReads(async () => {
      if (fail) throw new Error('Key revoked');
      return ok('sk-old');
    }, (endpoint) => shown.push(endpoint));
    await reads.refresh();
    fail = true;
    await reads.refresh();
    expect(shown.at(-1)).toEqual({ ok: false, error: 'Key revoked' });
  });

  it('drops an answer that a close or a newer read overtook', async () => {
    let release!: (endpoint: GatewayEndpointInfo) => void;
    const shown: Array<GatewayEndpointInfo | null> = [];
    const reads = createEndpointReads(() => new Promise((resolve) => { release = resolve; }), (endpoint) => shown.push(endpoint));
    const pending = reads.refresh();
    reads.close();
    release(ok('sk-late'));
    await pending;
    expect(shown.at(-1)).toBeNull();
  });

  it('copying reads the key again, so a key replaced while Home stays open is not what gets copied', async () => {
    let key = 'sk-old';
    const shown: Array<GatewayEndpointInfo | null> = [];
    const reads = createEndpointReads(async () => ok(key), (endpoint) => shown.push(endpoint));
    await reads.refresh();
    expect(shown.at(-1)).toEqual(ok('sk-old'));
    key = 'sk-new';
    expect(await readKeyToCopy(reads)).toBe('sk-new');
    expect(shown.at(-1)).toEqual(ok('sk-new'));
  });

  it('copying a key whose re-read fails copies nothing', async () => {
    let fail = false;
    const reads = createEndpointReads(async () => {
      if (fail) throw new Error('Key revoked');
      return ok('sk-old');
    }, () => undefined);
    await reads.refresh();
    fail = true;
    expect(await readKeyToCopy(reads)).toBeNull();
  });

  it('copying keeps the shown key row in place while the key is read again', async () => {
    const shown: Array<GatewayEndpointInfo | null> = [];
    const reads = createEndpointReads(async () => ok('sk-new'), (endpoint) => shown.push(endpoint));
    await reads.refresh();
    shown.length = 0;
    await readKeyToCopy(reads);
    // No `null` in between: the card's Copy key row isn't removed mid-copy.
    expect(shown).toEqual([ok('sk-new')]);
  });
});

describe('copyFreshKey', () => {
  it('copies the key read at that moment, never the one shown before', async () => {
    const copied: string[] = [];
    let key = 'sk-old';
    const reads = createEndpointReads(async () => ok(key), () => undefined);
    await reads.refresh();
    key = 'sk-replaced';
    expect(await copyFreshKey(() => readKeyToCopy(reads), async (value) => { copied.push(value); })).toBe(true);
    expect(copied).toEqual(['sk-replaced']);
  });

  it('copies nothing when the re-read fails', async () => {
    const copied: string[] = [];
    expect(await copyFreshKey(async () => null, async (value) => { copied.push(value); })).toBe(false);
    expect(await copyFreshKey(async () => { throw new Error('offline'); }, async (value) => { copied.push(value); })).toBe(false);
    expect(copied).toEqual([]);
  });
});
