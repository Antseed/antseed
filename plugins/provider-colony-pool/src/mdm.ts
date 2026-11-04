import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

/**
 * Asks the pool operator's own MDM for an Apple Managed Device Attestation
 * of an enrolled Mac (DeviceInformation → DevicePropertiesAttestation).
 * Antseed runs no MDM: each operator brings theirs.
 */
export interface DeviceAttestor {
  /** Base64 DER certificates, leaf first, whose freshness code is `nonce`. */
  attest(udid: string, nonce: Uint8Array): Promise<string[]>;
  stop?(): Promise<void>;
}

export interface NanoMdmAttestorOptions {
  /** NanoMDM base URL, e.g. https://mdm.example.com. */
  url: string;
  /** NanoMDM API key (HTTP basic auth as user `nanomdm`). */
  apiKey: string;
  /** Port this pool listens on for NanoMDM's webhook (`nanomdm -webhook-url http://<pool>:<port>/<path>`). */
  webhookPort: number;
  webhookHost?: string;
  /** Secret path NanoMDM posts to. */
  webhookPath: string;
  timeoutMs?: number;
  log?: (line: string) => void;
}

/** DeviceInformation answers can take a while: the Mac is woken by push and asks Apple for the attestation. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * NanoMDM (github.com/micromdm/nanomdm): commands are queued with
 * `PUT /v1/enqueue/<udid>` and answers arrive on its MicroMDM-style webhook
 * (`acknowledge_event.raw_payload`).
 */
export class NanoMdmAttestor implements DeviceAttestor {
  private server: Server | null = null;
  private readonly waiting = new Map<string, { resolve: (payload: PlistValue) => void; reject: (error: Error) => void }>();

  constructor(private readonly opts: NanoMdmAttestorOptions) {}

  async start(): Promise<void> {
    const path = `/${this.opts.webhookPath.replace(/^\//, '')}`;
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== path) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200).end();
        this.onWebhook(Buffer.concat(chunks));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.webhookPort, this.opts.webhookHost ?? '0.0.0.0', () => resolve());
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    for (const waiter of this.waiting.values()) waiter.reject(new Error('MDM attestor stopped'));
    this.waiting.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  async attest(udid: string, nonce: Uint8Array): Promise<string[]> {
    const commandUuid = randomUUID();
    const answer = new Promise<PlistValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(commandUuid);
        reject(new Error(`MDM did not answer DeviceInformation for ${udid} in time`));
      }, this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timer.unref();
      this.waiting.set(commandUuid, {
        resolve: (payload) => { clearTimeout(timer); resolve(payload); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
    const response = await fetch(`${this.opts.url.replace(/\/$/, '')}/v1/enqueue/${encodeURIComponent(udid)}`, {
      method: 'PUT',
      headers: {
        authorization: `Basic ${Buffer.from(`nanomdm:${this.opts.apiKey}`).toString('base64')}`,
        'content-type': 'application/xml',
      },
      body: deviceInformationCommand(commandUuid, nonce),
    }).catch((err: unknown) => {
      this.waiting.get(commandUuid)?.reject(err instanceof Error ? err : new Error(String(err)));
      return null;
    });
    if (response && !response.ok) {
      this.waiting.get(commandUuid)?.reject(new Error(`MDM refused the command (HTTP ${response.status})`));
    }
    const payload = await answer;
    const result = asDict(payload);
    if (result?.['Status'] !== 'Acknowledged') throw new Error(`Mac answered ${String(result?.['Status'] ?? 'nothing')}`);
    const chain = asDict(result['QueryResponses'])?.['DevicePropertiesAttestation'];
    if (!Array.isArray(chain) || chain.length === 0 || !chain.every((c) => c instanceof Uint8Array)) {
      throw new Error('Mac returned no DevicePropertiesAttestation (needs macOS 14+ on Apple silicon)');
    }
    return chain.map((cert) => Buffer.from(cert as Uint8Array).toString('base64'));
  }

  private onWebhook(body: Buffer): void {
    try {
      const event = JSON.parse(body.toString('utf-8')) as { acknowledge_event?: { command_uuid?: string; raw_payload?: string } };
      const ack = event.acknowledge_event;
      if (!ack?.command_uuid || !ack.raw_payload) return;
      const waiter = this.waiting.get(ack.command_uuid);
      if (!waiter) return;
      this.waiting.delete(ack.command_uuid);
      waiter.resolve(parsePlist(Buffer.from(ack.raw_payload, 'base64').toString('utf-8')));
    } catch (err) {
      this.opts.log?.(`[colony-pool] ignored an MDM webhook: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function deviceInformationCommand(commandUuid: string, nonce: Uint8Array): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Command</key><dict>
<key>RequestType</key><string>DeviceInformation</string>
<key>Queries</key><array><string>DevicePropertiesAttestation</string></array>
<key>DeviceAttestationNonce</key><data>${Buffer.from(nonce).toString('base64')}</data>
</dict>
<key>CommandUUID</key><string>${commandUuid}</string>
</dict></plist>
`;
}

// ── minimal XML property list reader (dict, array, data, string, integer, real, bool, date) ──

export type PlistValue = string | number | boolean | Date | Uint8Array | PlistValue[] | { [key: string]: PlistValue };

function asDict(value: PlistValue | undefined): Record<string, PlistValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array) && !(value instanceof Date)
    ? value : null;
}

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };
const unescape = (s: string) => s.replace(/&(lt|gt|amp|quot|apos);/g, (m) => ENTITIES[m]!);

export function parsePlist(xml: string): PlistValue {
  const tokens = xml.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/g, '').match(/<[^>]+>|[^<]+/g) ?? [];
  let i = 0;
  const skipSpace = () => { while (i < tokens.length && !tokens[i]!.startsWith('<') && tokens[i]!.trim() === '') i++; };
  const textUntil = (close: string): string => {
    let out = '';
    while (i < tokens.length && tokens[i] !== close) out += tokens[i++];
    i++;
    return unescape(out);
  };
  const value = (): PlistValue => {
    skipSpace();
    const tag = tokens[i++]!;
    switch (tag) {
      case '<dict>': {
        const dict: Record<string, PlistValue> = {};
        for (;;) {
          skipSpace();
          if (tokens[i] === '</dict>') { i++; return dict; }
          if (tokens[i++] !== '<key>') throw new Error('plist: expected <key>');
          const key = textUntil('</key>');
          dict[key] = value();
        }
      }
      case '<dict/>': return {};
      case '<array>': {
        const array: PlistValue[] = [];
        for (;;) {
          skipSpace();
          if (tokens[i] === '</array>') { i++; return array; }
          array.push(value());
        }
      }
      case '<array/>': return [];
      case '<string>': return textUntil('</string>');
      case '<string/>': return '';
      case '<data>': return new Uint8Array(Buffer.from(textUntil('</data>').replace(/\s+/g, ''), 'base64'));
      case '<integer>': return Number(textUntil('</integer>'));
      case '<real>': return Number(textUntil('</real>'));
      case '<date>': return new Date(textUntil('</date>'));
      case '<true/>': return true;
      case '<false/>': return false;
      default: throw new Error(`plist: unexpected ${tag}`);
    }
  };
  skipSpace();
  if (tokens[i] === '<plist version="1.0">' || tokens[i]?.startsWith('<plist')) i++;
  return value();
}
