import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { VIDEO_DOWNLOAD_MAX_BYTES, type ProviderStreamCallbacks, type SerializedHttpRequest, type SerializedHttpResponse } from '@antseed/node';
import { streamVideoResponse, videoDownloadError } from '@antseed/provider-core';

export async function streamVeniceVideo(
  request: SerializedHttpRequest,
  upstream: Response,
  callbacks: ProviderStreamCallbacks,
  download: { signal: AbortSignal; progress: () => void },
): Promise<SerializedHttpResponse> {
  if (upstream.headers.has('content-length') || !upstream.body || upstream.status !== 200
    || upstream.headers.get('content-type')?.split(';')[0]?.trim() !== 'video/mp4'
    || ![null, 'identity'].includes(upstream.headers.get('content-encoding'))) {
    return streamVideoResponse(request, upstream, callbacks, download);
  }
  const reader = upstream.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  download.signal.addEventListener('abort', cancel, { once: true });
  let directory: string | undefined;
  try {
    download.signal.throwIfAborted();
    directory = await mkdtemp(join(tmpdir(), 'antseed-venice-download-'));
    const path = join(directory, 'video.mp4');
    const file = await open(path, 'wx', 0o600);
    let length = 0;
    try {
      while (true) {
        download.signal.throwIfAborted();
        const { value, done } = await reader.read();
        download.signal.throwIfAborted();
        if (done) break;
        length += value.length;
        if (length > VIDEO_DOWNLOAD_MAX_BYTES) return videoDownloadError(request, 413, 'video_download_unavailable', 'Video exceeds download limits');
        await file.writeFile(value);
        download.progress();
      }
    } finally {
      await file.close();
    }
    const body = createReadStream(path, { signal: download.signal });
    try {
      return await streamVideoResponse(request, new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, {
        headers: { 'content-type': 'video/mp4', 'content-length': String(length) },
      }), callbacks, download);
    } finally {
      body.destroy();
    }
  } finally {
    download.signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
