import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_WEBHOOK_BODY_BYTES, NanoMdmAttestor, parsePlist } from './mdm.js';

const SECRET = '9f2c4e7a1b8d3f60';

/** A NanoMDM stand-in: takes the enqueued command and answers through the webhook, as a Mac would. */
async function fakeNanoMdm(webhook: () => string, answer: (command: Record<string, any>) => string): Promise<{ server: Server; url: string; auth: string[] }> {
  const auth: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      auth.push(req.headers.authorization ?? '');
      res.writeHead(200).end('{}');
      const command = parsePlist(Buffer.concat(chunks).toString()) as Record<string, any>;
      const raw = Buffer.from(answer(command)).toString('base64');
      void fetch(webhook(), {
        method: 'POST',
        body: JSON.stringify({ topic: 'mdm.Connect', acknowledge_event: { udid: req.url!.split('/').pop(), status: 'Acknowledged', command_uuid: command['CommandUUID'], raw_payload: raw } }),
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${address.port}`, auth };
}

const ack = (uuid: string, certs: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CommandUUID</key><string>${uuid}</string>
<key>QueryResponses</key><dict><key>DevicePropertiesAttestation</key><array>${certs.map((c) => `<data>\n${c}\n</data>`).join('')}</array></dict>
<key>Status</key><string>Acknowledged</string>
<key>UDID</key><string>X</string>
</dict></plist>`;

describe('NanoMDM device attestor', () => {
  const stops: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const stop of stops.splice(0)) await stop(); });

  it('enqueues DeviceInformation with the nonce and returns the attestation chain from the webhook', async () => {
    let commandSeen: Record<string, any> = {};
    const attestor = new NanoMdmAttestor({ url: '', apiKey: 'k', webhookPort: 0, webhookHost: '127.0.0.1', webhookPath: SECRET });
    const mdm = await fakeNanoMdm(() => `http://127.0.0.1:${(attestor as any).server.address().port}/${SECRET}`, (command) => {
      commandSeen = command;
      return ack(command['CommandUUID'], ['AQID', 'BAUG']);
    });
    stops.push(() => new Promise((r) => mdm.server.close(() => r())), () => attestor.stop());
    (attestor as any).opts.url = mdm.url;
    await attestor.start();

    const nonce = new Uint8Array(32).fill(7);
    await expect(attestor.attest('UDID-1', nonce)).resolves.toEqual(['AQID', 'BAUG']);
    expect(commandSeen['Command']).toMatchObject({ RequestType: 'DeviceInformation', Queries: ['DevicePropertiesAttestation'] });
    expect(Buffer.from(commandSeen['Command'].DeviceAttestationNonce)).toEqual(Buffer.from(nonce));
    expect(mdm.auth[0]).toBe(`Basic ${Buffer.from('nanomdm:k').toString('base64')}`);
  });

  it('fails when the Mac returns an error or no attestation', async () => {
    const attestor = new NanoMdmAttestor({ url: '', apiKey: 'k', webhookPort: 0, webhookHost: '127.0.0.1', webhookPath: SECRET });
    const mdm = await fakeNanoMdm(() => `http://127.0.0.1:${(attestor as any).server.address().port}/${SECRET}`, (command) =>
      `<plist version="1.0"><dict><key>CommandUUID</key><string>${command['CommandUUID']}</string><key>Status</key><string>Error</string></dict></plist>`);
    stops.push(() => new Promise((r) => mdm.server.close(() => r())), () => attestor.stop());
    (attestor as any).opts.url = mdm.url;
    await attestor.start();
    await expect(attestor.attest('UDID-1', new Uint8Array(32))).rejects.toThrow(/answered Error/);
  });

  it('times out cleanly when NanoMDM never answers the enqueue', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    stops.push(async () => { process.off('unhandledRejection', unhandled); });
    // Accepts the connection and never responds.
    const stalled = createServer(() => {});
    await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', () => resolve()));
    stops.push(() => new Promise((r) => { stalled.closeAllConnections(); stalled.close(() => r()); }));
    const attestor = new NanoMdmAttestor({
      url: `http://127.0.0.1:${(stalled.address() as { port: number }).port}`, apiKey: 'k', webhookPort: 0, webhookHost: '127.0.0.1', webhookPath: SECRET, timeoutMs: 100,
    });
    await attestor.start();
    stops.push(() => attestor.stop());

    await expect(attestor.attest('UDID-1', new Uint8Array(32))).rejects.toThrow(/did not answer DeviceInformation for UDID-1 in time/);
    expect((attestor as any).waiting.size).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('refuses a guessable webhook path', () => {
    expect(() => new NanoMdmAttestor({ url: '', apiKey: 'k', webhookPort: 0, webhookPath: 'mdm-webhook' })).toThrow(/at least 16/);
  });

  it('refuses oversized webhook bodies with 413 without buffering them', async () => {
    const attestor = new NanoMdmAttestor({ url: '', apiKey: 'k', webhookPort: 0, webhookHost: '127.0.0.1', webhookPath: SECRET });
    await attestor.start();
    stops.push(() => attestor.stop());
    const webhook = `http://127.0.0.1:${(attestor as any).server.address().port}/${SECRET}`;
    const onWebhook = vi.spyOn(attestor as any, 'onWebhook');

    const declared = await fetch(webhook, { method: 'POST', body: Buffer.alloc(MAX_WEBHOOK_BODY_BYTES + 1) });
    expect(declared.status).toBe(413);

    // A chunked body with no length is cut off once it passes the cap.
    let sent = 0;
    const chunked = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 64) controller.enqueue(new Uint8Array(16 * 1024));
        else controller.close();
      },
    });
    const streamed = await fetch(webhook, { method: 'POST', body: chunked, duplex: 'half' } as RequestInit).catch(() => null);
    expect(streamed === null || streamed.status === 413).toBe(true);
    expect(onWebhook).not.toHaveBeenCalled();
  });
});
