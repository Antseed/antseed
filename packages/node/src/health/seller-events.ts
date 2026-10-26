import { appendFile, open, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Seller event journal: `<dataDir>/seller-events.jsonl`, newest last. */
export const SELLER_EVENTS_FILE = 'seller-events.jsonl';
/** The journal is rotated to `seller-events.1.jsonl` past this size. */
export const SELLER_EVENTS_MAX_BYTES = 1_000_000;

export type SellerEventKind =
  | 'started'
  | 'stopped'
  | 'crashed'
  | 'model_down'
  | 'model_up'
  | 'gas_low'
  | 'gas_ok'
  | 'idle'
  | 'active'
  | 'upstream_credit'
  | 'upstream_credit_ok'
  | 'upstream_balance_low'
  | 'upstream_balance_ok'
  | 'test';

export type SellerEventSeverity = 'info' | 'warning' | 'critical';

export interface SellerEvent {
  /** Unix milliseconds. */
  at: number;
  kind: SellerEventKind;
  severity: SellerEventSeverity;
  /** One line, plain text, safe to post to a chat. */
  title: string;
  detail?: string;
  provider?: string;
  /** The configured provider name, when several instances share a plugin name. */
  providerId?: string;
  service?: string;
}

const eventsPath = (dataDir: string) => join(dataDir, SELLER_EVENTS_FILE);
const rotatedPath = (dataDir: string) => join(dataDir, 'seller-events.1.jsonl');

/** Appends in flight, per journal: the size check, rotation and append run one at a time so two writers never rotate twice. */
const appendQueues = new Map<string, Promise<void>>();

/** Append one event, rotating the journal once it passes SELLER_EVENTS_MAX_BYTES. */
export function appendSellerEvent(dataDir: string, event: SellerEvent): Promise<void> {
  const path = eventsPath(dataDir);
  const write = async () => {
    const size = await stat(path).then((s) => s.size, () => 0);
    if (size > SELLER_EVENTS_MAX_BYTES) await rename(path, rotatedPath(dataDir)).catch(() => {});
    // A crash mid-write leaves a line without its newline: close it off, so
    // this event starts its own line instead of joining the torn one.
    const torn = size > 0 && size <= SELLER_EVENTS_MAX_BYTES && !(await endsWithNewline(path));
    await appendFile(path, `${torn ? '\n' : ''}${JSON.stringify(event)}\n`);
  };
  const run = (appendQueues.get(path) ?? Promise.resolve()).then(write);
  // A failed append does not hold up the next one.
  const settled = run.catch(() => {});
  appendQueues.set(path, settled);
  void settled.then(() => { if (appendQueues.get(path) === settled) appendQueues.delete(path); });
  return run;
}

async function endsWithNewline(path: string): Promise<boolean> {
  const file = await open(path, 'r').catch(() => null);
  if (!file) return true;
  try {
    const { size } = await file.stat();
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    await file.read(last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    await file.close();
  }
}

function parseLines(text: string): SellerEvent[] {
  const events: SellerEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as SellerEvent;
      if (typeof event.at === 'number' && typeof event.kind === 'string') events.push(event);
    } catch {
      // A torn final line from a crash mid-write; skip it.
    }
  }
  return events;
}

/** The latest `limit` events, newest first (reads the rotated file when the current one is short). */
export async function readSellerEvents(dataDir: string, limit = 200): Promise<SellerEvent[]> {
  const current = parseLines(await readFile(eventsPath(dataDir), 'utf-8').catch(() => ''));
  const events = current.length >= limit
    ? current
    : [...parseLines(await readFile(rotatedPath(dataDir), 'utf-8').catch(() => '')), ...current];
  return events.slice(-limit).reverse();
}
