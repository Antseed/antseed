import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { SerializedHttpRequest } from '@antseed/node';
import { createVideoSourcePrecheck, isPublicIpAddress, measureVideoSource, VideoSourceError } from './video-source.js';

function box(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

function mp4(durationMs: number, options: { mediaBytes?: number; moovLast?: boolean } = {}): Buffer {
  const mvhd = Buffer.alloc(20);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(durationMs, 16);
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1'));
  const moov = box('moov', box('mvhd', mvhd));
  const mdat = box('mdat', Buffer.alloc(options.mediaBytes ?? 1000, 7));
  return options.moovLast ? Buffer.concat([ftyp, mdat, moov]) : Buffer.concat([ftyp, moov, mdat]);
}

const dataUrl = (bytes: Buffer) => `data:video/mp4;base64,${bytes.toString('base64')}`;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

/** Serves `file`; with `ranges`, answers range requests like a CDN, otherwise sends the whole file. */
async function serve(file: Buffer, options: { ranges?: boolean } = {}): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(String(req.headers.range ?? 'none'));
    const range = String(req.headers.range ?? '').match(/^bytes=(\d+)-(\d+)$/);
    if (options.ranges && range) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), file.length - 1);
      res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/${file.length}`, 'content-length': String(end - start + 1) });
      res.end(file.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(file.length) });
    res.end(file);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/source.mp4`, requests };
}

const local = { allowHttp: true, allowPrivateNetwork: true };

describe('measureVideoSource', () => {
  it('reads the duration of an inline MP4', async () => {
    await expect(measureVideoSource(dataUrl(mp4(12_340)))).resolves.toEqual({ durationMs: 12_340, sizeBytes: mp4(12_340).length });
  });

  it('refuses inline data that is not an MP4, and files over the size limit', async () => {
    await expect(measureVideoSource(dataUrl(Buffer.from('not a video')))).rejects.toMatchObject({ statusCode: 400, code: 'invalid_video_source' });
    await expect(measureVideoSource('data:video/mp4,plain')).rejects.toMatchObject({ code: 'invalid_video_source' });
    await expect(measureVideoSource(dataUrl(mp4(5_000, { mediaBytes: 5000 })), { maxBytes: 1000 })).rejects.toMatchObject({ statusCode: 413, code: 'video_source_too_large' });
  });

  it('reads a URL source with range requests, with moov at the start or the end, without downloading the media', async () => {
    const front = await serve(mp4(9_000, { mediaBytes: 2_000_000 }), { ranges: true });
    await expect(measureVideoSource(front.url, local)).resolves.toMatchObject({ durationMs: 9_000 });
    expect(front.requests).toEqual(['bytes=0-65535']);
    const back = await serve(mp4(7_500, { mediaBytes: 2_000_000, moovLast: true }), { ranges: true });
    await expect(measureVideoSource(back.url, local)).resolves.toMatchObject({ durationMs: 7_500, sizeBytes: mp4(7_500, { mediaBytes: 2_000_000, moovLast: true }).length });
    expect(back.requests.length).toBeLessThanOrEqual(4);
  });

  it('reads a server without range support up to the size limit', async () => {
    const small = await serve(mp4(6_000));
    await expect(measureVideoSource(small.url, local)).resolves.toMatchObject({ durationMs: 6_000 });
    const large = await serve(mp4(6_000, { mediaBytes: 50_000 }));
    await expect(measureVideoSource(large.url, { ...local, maxBytes: 10_000 })).rejects.toMatchObject({ statusCode: 413 });
  });

  it('refuses a URL source larger than the limit from its range answer', async () => {
    const source = await serve(mp4(6_000, { mediaBytes: 200_000 }), { ranges: true });
    await expect(measureVideoSource(source.url, { ...local, maxBytes: 100_000 })).rejects.toMatchObject({ statusCode: 413, code: 'video_source_too_large' });
  });

  it('refuses private addresses, plain http and credentials', async () => {
    const source = await serve(mp4(6_000), { ranges: true });
    await expect(measureVideoSource(source.url, { allowHttp: true })).rejects.toMatchObject({ code: 'video_source_unavailable' });
    await expect(measureVideoSource(source.url.replace('http:', 'https:'))).rejects.toMatchObject({ code: 'video_source_unavailable' });
    await expect(measureVideoSource(source.url, { allowPrivateNetwork: true })).rejects.toMatchObject({ code: 'invalid_video_source' });
    await expect(measureVideoSource('https://user:pass@example.com/a.mp4')).rejects.toBeInstanceOf(VideoSourceError);
    await expect(measureVideoSource('ftp://example.com/a.mp4')).rejects.toBeInstanceOf(VideoSourceError);
  });

  it('tells public addresses from private ones', () => {
    expect(isPublicIpAddress('8.8.8.8')).toBe(true);
    expect(isPublicIpAddress('2606:4700::1111')).toBe(true);
    expect(isPublicIpAddress('::ffff:8.8.8.8')).toBe(true);
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'not-an-ip',
      '::7f00:1', '::127.0.0.1', '::ffff:7f00:1', '2002:7f00:1::1', '2001::1', '2001:0:4136:e378::1', '100::1', '64:ff9b::7f00:1', 'fec0::1', '2001:db8::1', '0:0:0:0:0:0:0:1', '::ffff:10.0.0.1']) {
      expect(isPublicIpAddress(address), address).toBe(false);
    }
  });
});

describe('source checks before reading', () => {
  it('refuses inline sources that are not labeled as video', async () => {
    await expect(measureVideoSource(`data:image/png;base64,${mp4(5_000).toString('base64')}`)).rejects.toMatchObject({ code: 'invalid_video_source' });
    await expect(measureVideoSource(`data:video/quicktime;base64,${mp4(5_000).toString('base64')}`)).resolves.toMatchObject({ durationMs: 5_000 });
  });

  it('uses the longest track when the movie header claims a shorter file', async () => {
    const mvhd = Buffer.alloc(20);
    mvhd.writeUInt32BE(1000, 12);
    mvhd.writeUInt32BE(6_500, 16);
    const mdhd = Buffer.alloc(24);
    mdhd.writeUInt32BE(1000, 12);
    mdhd.writeUInt32BE(37_250, 16);
    const file = Buffer.concat([
      box('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1')),
      box('moov', Buffer.concat([box('mvhd', mvhd), box('trak', box('mdia', box('mdhd', mdhd)))])),
      box('mdat', Buffer.alloc(100)),
    ]);
    await expect(measureVideoSource(dataUrl(file))).resolves.toMatchObject({ durationMs: 37_250 });
  });
});

describe('createVideoSourcePrecheck', () => {
  const request = (body: object, requestId = 'r1'): SerializedHttpRequest => ({
    requestId, method: 'POST', path: '/fal/v1/video/queue', headers: {}, body: Buffer.from(JSON.stringify(body)),
  });
  const parse = (body: Uint8Array) => JSON.parse(Buffer.from(body).toString());
  const rule = { minSeconds: 5, maxSeconds: 30, durationMatchesSource: true };

  it('accepts a duration equal to the source length rounded down, and refuses others before payment', async () => {
    const precheck = createVideoSourcePrecheck();
    const source = dataUrl(mp4(12_900));
    await expect(precheck(request({ d: 12 }), 'buyer', source, 12, rule)).resolves.toBeNull();
    for (const declared of [13, 11, undefined]) {
      const response = await precheck(request({ d: declared }, `r-${declared}`), 'buyer', source, declared, rule);
      expect(response?.statusCode).toBe(400);
      expect(parse(response!.body).error).toMatchObject({ code: 'invalid_video_duration' });
      expect(parse(response!.body).error.message).toContain('"duration": 12');
    }
  });

  it('refuses sources outside the model\'s range', async () => {
    const precheck = createVideoSourcePrecheck();
    const short = await precheck(request({}), 'buyer', dataUrl(mp4(4_200)), 4, rule);
    expect(parse(short!.body).error).toMatchObject({ code: 'invalid_video_source', message: expect.stringContaining('5 to 30 s') });
    const long = await precheck(request({}, 'r2'), 'buyer', dataUrl(mp4(31_000)), 31, rule);
    expect(long?.statusCode).toBe(400);
  });

  it('refuses a duration longer than the source when the model cuts to it', async () => {
    const precheck = createVideoSourcePrecheck();
    const cut = { durationMatchesSource: false, durationAtMostSource: true };
    await expect(precheck(request({}), 'buyer', dataUrl(mp4(8_400)), 5, cut)).resolves.toBeNull();
    await expect(precheck(request({}, 'r2'), 'buyer', dataUrl(mp4(8_400)), undefined, cut)).resolves.toBeNull();
    const response = await precheck(request({}, 'r3'), 'buyer', dataUrl(mp4(8_400)), 10, cut);
    expect(parse(response!.body).error).toMatchObject({ code: 'invalid_video_duration', message: expect.stringContaining('at most 8') });
  });

  it('measures a request once, so the resend after the payment channel opens is not fetched again', async () => {
    let calls = 0;
    const precheck = createVideoSourcePrecheck({ measure: async () => { calls += 1; return { durationMs: 10_000 }; } });
    const req = request({ video_url: 'https://example.com/a.mp4', duration: 10 });
    await expect(precheck(req, 'buyer', 'https://example.com/a.mp4', 10, rule)).resolves.toBeNull();
    await expect(precheck(req, 'buyer', 'https://example.com/a.mp4', 10, rule)).resolves.toBeNull();
    expect(calls).toBe(1);
    await precheck(request({ video_url: 'https://example.com/a.mp4', duration: 9 }), 'buyer', 'https://example.com/a.mp4', 9, rule);
    expect(calls).toBe(2);
  });

  it('refuses sources outside the size, aspect ratio and frame rate limits', async () => {
    const shaped = (facts: object) => createVideoSourcePrecheck({ measure: async () => ({ durationMs: 6_000, ...facts }) });
    const limits = { durationMatchesSource: false, minWidth: 700, minHeight: 700, minAspectRatio: 0.4, maxAspectRatio: 2.5, minFps: 23.9, maxFps: 60.05 };
    const src = dataUrl(mp4(6_000));
    const small = await shaped({ width: 864, height: 496, fps: 24 })(request({}), 'buyer', src, 6, limits);
    expect(parse(small!.body).error).toMatchObject({ code: 'invalid_video_source', message: expect.stringContaining('864x496') });
    const slow = await shaped({ width: 1280, height: 720, fps: 15 })(request({}), 'buyer', src, 6, { ...limits, minHeight: 700 });
    expect(parse(slow!.body).error.message).toContain('15 fps');
    const wide = await shaped({ width: 3000, height: 1000, fps: 24 })(request({}), 'buyer', src, 6, limits);
    expect(parse(wide!.body).error.message).toContain('aspect ratio');
    await expect(shaped({ width: 1218, height: 700, fps: 24 })(request({}), 'buyer', src, 6, limits)).resolves.toBeNull();
  });

  it('refuses malformed sources without using the URL check quota', async () => {
    const precheck = createVideoSourcePrecheck({ maxUrlChecksPerBuyerPerMinute: 1, measure: async () => ({ durationMs: 10_000 }) });
    for (const [id, bad] of [['x', 'file:///etc/passwd'], ['y', 'ftp://example.com/a.mp4'], ['z', 'hello'], ['w', 'http://example.com/a.mp4']]) {
      const response = await precheck(request({}, id), 'buyer', bad!, 10, rule);
      expect(parse(response!.body).error.code).toBe('invalid_video_source');
    }
    await expect(precheck(request({}, 'ok'), 'buyer', 'https://example.com/a.mp4', 10, rule)).resolves.toBeNull();
  });

  it('limits URL checks per buyer', async () => {
    const precheck = createVideoSourcePrecheck({ maxUrlChecksPerBuyerPerMinute: 2, measure: async () => ({ durationMs: 10_000 }) });
    for (const id of ['a', 'b']) await expect(precheck(request({}, id), 'buyer', 'https://example.com/a.mp4', 10, rule)).resolves.toBeNull();
    const busy = await precheck(request({}, 'c'), 'buyer', 'https://example.com/a.mp4', 10, rule);
    expect(busy?.statusCode).toBe(429);
    await expect(precheck(request({}, 'd'), 'other-buyer', 'https://example.com/a.mp4', 10, rule)).resolves.toBeNull();
    // Inline sources are not rate limited: they cost the seller no fetch.
    await expect(precheck(request({}, 'e'), 'buyer', dataUrl(mp4(10_000)), 10, rule)).resolves.toBeNull();
  });
});
