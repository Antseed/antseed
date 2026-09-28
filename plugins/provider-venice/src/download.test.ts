import { access } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { streamVeniceVideo } from './download.js';

const directories = vi.hoisted(() => [] as string[]);
vi.mock('@antseed/node', async importOriginal => ({ ...await importOriginal<typeof import('@antseed/node')>(), VIDEO_DOWNLOAD_MAX_BYTES: 64 }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdtemp: async (prefix: string) => {
      const directory = await actual.mkdtemp(prefix);
      directories.push(directory);
      return directory;
    },
  };
});

afterEach(async () => {
  for (const directory of directories.splice(0)) await expect(access(directory)).rejects.toThrow();
});

const request = { requestId: 'chunked', method: 'POST', path: '/api/v1/video/retrieve', headers: {}, body: new Uint8Array() };
const callbacks = () => ({ signal: new AbortController().signal, onResponseStart: vi.fn(), onResponseChunk: vi.fn() });

it('measures a chunked MP4 on disk before starting its signed stream', async () => {
  const handlers = callbacks();
  const upstream = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('first'));
      controller.enqueue(Buffer.from('second'));
      controller.close();
    },
  }), { headers: { 'content-type': 'video/mp4' } });
  const result = await streamVeniceVideo(request, upstream, handlers, { signal: handlers.signal, progress: vi.fn() });
  expect(result.statusCode).toBe(200);
  expect(handlers.onResponseStart.mock.calls[0]![0].headers['content-length']).toBe('11');
  expect(Buffer.concat(handlers.onResponseChunk.mock.calls.map(([chunk]) => chunk.data)).toString()).toBe('firstsecond');
  expect(directories).toHaveLength(1);
});

it('keeps known-length responses streaming without temporary files', async () => {
  const handlers = callbacks();
  await streamVeniceVideo(request, new Response('video', { headers: { 'content-type': 'video/mp4', 'content-length': '5' } }), handlers, { signal: handlers.signal, progress() {} });
  expect(handlers.onResponseStart).toHaveBeenCalledOnce();
  expect(directories).toHaveLength(0);
});

it('rejects oversized chunked videos and removes their temporary file', async () => {
  const handlers = callbacks();
  const response = await streamVeniceVideo(request, new Response(new Uint8Array(65), { headers: { 'content-type': 'video/mp4' } }), handlers, { signal: handlers.signal, progress() {} });
  expect(response.statusCode).toBe(413);
  expect(handlers.onResponseStart).not.toHaveBeenCalled();
});

it('cancels upstream and cleans up when the buyer disconnects during staging', async () => {
  const controller = new AbortController();
  const cancelled = vi.fn();
  const handlers = callbacks();
  const upstream = new Response(new ReadableStream({
    start(stream) { stream.enqueue(Buffer.from('video')); },
    cancel: cancelled,
  }), { headers: { 'content-type': 'video/mp4' } });
  await expect(streamVeniceVideo(request, upstream, handlers, { signal: controller.signal, progress() { controller.abort(); } })).rejects.toThrow();
  expect(cancelled).toHaveBeenCalledOnce();
  expect(handlers.onResponseStart).not.toHaveBeenCalled();
});

it('does not turn a failed chunked upstream into a completed video', async () => {
  let pulls = 0;
  const handlers = callbacks();
  const upstream = new Response(new ReadableStream({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(Buffer.from('video'));
      else controller.error(new Error('upstream disconnected'));
    },
  }), { headers: { 'content-type': 'video/mp4' } });
  await expect(streamVeniceVideo(request, upstream, handlers, { signal: handlers.signal, progress() {} })).rejects.toThrow('upstream disconnected');
  expect(handlers.onResponseStart).not.toHaveBeenCalled();
});
