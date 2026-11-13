import {describe, expect, it} from 'vitest';
import {trackedStream} from './stream';

// Node has no FixedLengthStream, so these tests exercise the TransformStream
// fallback — the pipe semantics (complete / abort / origin error) are the
// same for both identity streams.

function sourceOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]!);
      } else {
        controller.close();
      }
    },
  });
}

const chunk = (size: number) => new Uint8Array(size);

async function drain(readable: ReadableStream<Uint8Array>): Promise<number> {
  const reader = readable.getReader();
  let bytes = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) return bytes;
    bytes += value.byteLength;
  }
}

describe('trackedStream', () => {
  it('reports completed and passes every byte through when the client drains the stream', async () => {
    const {readable, done} = trackedStream(sourceOf([chunk(1000), chunk(500), chunk(1)]), 1501);
    expect(await drain(readable)).toBe(1501);
    expect((await done).completed).toBe(true);
  });

  it('reports aborted when the client cancels mid-transfer', async () => {
    const {readable, done} = trackedStream(sourceOf([chunk(1000), chunk(1000), chunk(1000)]), 3000);
    const reader = readable.getReader();
    await reader.read();
    await reader.cancel();
    expect((await done).completed).toBe(false);
  });

  it('reports aborted when the origin stream errors', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk(100));
        controller.error(new Error('origin died'));
      },
    });
    const {readable, done} = trackedStream(source, null);
    const reader = readable.getReader();
    await reader.read().catch(() => {});
    await reader.read().catch(() => {});
    expect((await done).completed).toBe(false);
  });

  it('handles an empty body as a completion', async () => {
    const {readable, done} = trackedStream(sourceOf([]), null);
    expect(await drain(readable)).toBe(0);
    expect((await done).completed).toBe(true);
  });
});
