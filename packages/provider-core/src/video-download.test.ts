import { describe, expect, it } from 'vitest';
import { VIDEO_DOWNLOAD_BUSY_CODE as NODE_BUSY_CODE } from '@antseed/node';
import type { SerializedHttpRequest } from '@antseed/node';
import { VIDEO_DOWNLOAD_BUSY_CODE, VIDEO_DOWNLOAD_BUSY_RETRY_AFTER_SECONDS, createVideoResponseStreamer, videoDownloadSignal } from './video-download.js';

const request: SerializedHttpRequest = { requestId: 'r', method: 'POST', path: '/fal/v1/video/retrieve', headers: {}, body: new Uint8Array(0) };

describe('createVideoResponseStreamer', () => {
  it('answers a download past its limit as busy, with a retry-after the seller passes on', async () => {
    const stream = createVideoResponseStreamer(0);
    const response = await stream(request, new Response('video'), { onResponseStart: () => {}, onResponseChunk: async () => {} } as never, videoDownloadSignal(new AbortController().signal));
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe(String(VIDEO_DOWNLOAD_BUSY_RETRY_AFTER_SECONDS));
    expect(JSON.parse(Buffer.from(response.body).toString()).error.code).toBe(VIDEO_DOWNLOAD_BUSY_CODE);
  });

  it('uses the busy code the seller recognizes', () => {
    expect(VIDEO_DOWNLOAD_BUSY_CODE).toBe(NODE_BUSY_CODE);
  });
});
