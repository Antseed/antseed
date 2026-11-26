import { describe, expect, it } from 'vitest';
import { VIDEO_DOWNLOAD_BUSY_CODE as NODE_BUSY_CODE } from '@antseed/node';
import type { SerializedHttpRequest } from '@antseed/node';
import { DEFAULT_MAX_VIDEO_DOWNLOADS, VIDEO_DOWNLOAD_BUSY_CODE, VIDEO_DOWNLOAD_BUSY_RETRY_AFTER_SECONDS, createVideoResponseStreamer, parseMaxVideoDownloads, videoDownloadSignal } from './video-download.js';

const request: SerializedHttpRequest = { requestId: 'r', method: 'POST', path: '/fal/v1/video/retrieve', headers: {}, body: new Uint8Array(0) };

describe('createVideoResponseStreamer', () => {
  it('answers a download past its limit as busy, with a retry-after the seller passes on', async () => {
    const stream = createVideoResponseStreamer(0);
    const response = await stream(request, new Response('video'), { onResponseStart: () => {}, onResponseChunk: async () => {} }, videoDownloadSignal(new AbortController().signal));
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe(String(VIDEO_DOWNLOAD_BUSY_RETRY_AFTER_SECONDS));
    expect(JSON.parse(Buffer.from(response.body).toString()).error.code).toBe(VIDEO_DOWNLOAD_BUSY_CODE);
  });

  it('uses the busy code the seller recognizes', () => {
    expect(VIDEO_DOWNLOAD_BUSY_CODE).toBe(NODE_BUSY_CODE);
  });
});

describe('parseMaxVideoDownloads', () => {
  it('defaults to six and accepts a positive integer', () => {
    expect(parseMaxVideoDownloads({})).toBe(DEFAULT_MAX_VIDEO_DOWNLOADS);
    expect(DEFAULT_MAX_VIDEO_DOWNLOADS).toBe(6);
    expect(parseMaxVideoDownloads({ ANTSEED_MAX_VIDEO_DOWNLOADS: '12' })).toBe(12);
  });

  it.each(['0', '-1', '1.5', 'many'])('rejects %s', (value) => {
    expect(() => parseMaxVideoDownloads({ ANTSEED_MAX_VIDEO_DOWNLOADS: value })).toThrow('ANTSEED_MAX_VIDEO_DOWNLOADS');
  });
});
