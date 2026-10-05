import { ANTSEED_MODEL_MAX_OUTPUT_TOKENS } from '@antseed/node/types';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {
  CLAUDE_GATEWAY_DEFAULT_PORT,
  ROUTED_MODEL_ALIAS,
} from '../system-proxy/config-patch.js';

/**
 * Loopback gateway for Claude Desktop's native third-party inference mode.
 *
 * Claude Desktop, once its profile points here (see the `claude-desktop`
 * config patch), sends its ordinary Anthropic Messages traffic to this
 * server: `GET /v1/models` for the model picker, `POST /v1/messages` and
 * `POST /v1/messages/count_tokens` for inference. The buyer proxy already
 * speaks all three — but its `/v1/models` catalog uses the OpenAI list shape,
 * and Claude's picker only accepts Anthropic's shape with family tiers. So
 * the gateway answers the catalog itself (see CLAUDE_MODEL_SLOTS) and
 * forwards the message routes to the buyer proxy with the model rewritten to
 * what its slot was advertised for — "Antseed Auto" follows the route
 * selected in the desktop (floating pill / AI VPN), so it drives Claude
 * conversations live without a config rewrite.
 *
 * Plain HTTP reverse proxy on 127.0.0.1: Claude terminates its own gateway
 * protocol here, so no TLS interception or trust changes are involved.
 */

const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
export const CLAUDE_GATEWAY_HEALTH_PATH = '/_antseed/claude-gateway';
export const CLAUDE_GATEWAY_HEALTH_HEADER = 'x-antseed-claude-gateway';

/**
 * Claude Desktop's picker only lists the model ids it knows, grouped by
 * Anthropic family — so network models are advertised behind Claude's own
 * ids, with the real model name as the display name (exactly how Ollama's
 * gateway does it). Five ids means at most five entries: the first slot is
 * always "Antseed Auto" (the route selected in the desktop), the rest carry
 * the top of the desktop's curated model picker. Advertised in Claude's
 * preferred order.
 */
const CLAUDE_MODEL_SLOTS: readonly { id: string; family: string; createdAt: string; familyDefault: boolean }[] = [
  { id: 'claude-fable-5', family: 'fable', createdAt: '2026-06-09T00:00:00Z', familyDefault: true },
  { id: 'claude-opus-5', family: 'opus', createdAt: '2026-07-24T00:00:00Z', familyDefault: true },
  { id: 'claude-sonnet-5', family: 'sonnet', createdAt: '2026-06-30T00:00:00Z', familyDefault: true },
  { id: 'claude-sonnet-4-6', family: 'sonnet', createdAt: '2025-11-18T00:00:00Z', familyDefault: false },
  { id: 'claude-haiku-4-5-20251001', family: 'haiku', createdAt: '2025-10-01T00:00:00Z', familyDefault: true },
];
const CLAUDE_GATEWAY_MODEL_LABEL = 'Antseed Auto';

/** A model offered to Claude's picker: display label + the model the buyer
    proxy should route when Claude picks it. */
export type ClaudeGatewayModel = { label: string; model: string };

/**
 * Curated models for the picker slots, injected by main.ts from the chat
 * engine's model-picker snapshot (the renderer's favorites-then-recommended
 * rows — the same source the Telegram bridge offers). Module state rather
 * than a constructor dep because the chat engine is created after the
 * system-proxy runtime that starts this gateway.
 */
let sharedModelSource: (() => readonly ClaudeGatewayModel[]) | null = null;

export function setClaudeDesktopGatewayModelSource(source: () => readonly ClaudeGatewayModel[]): void {
  sharedModelSource = source;
}

/**
 * Internal marker the buyer proxy uses for conversation attribution and
 * strips before dispatch. Claude Desktop stamps `x-claude-cli-session-id` on
 * its requests — the same slug as t3code's Claude Code sessions — so without
 * this source override its chats would display under T3 Code. Must match
 * SYSTEM_PROXY_SOURCE_HEADER in apps/cli/src/proxy/request-utils.ts.
 */
const SYSTEM_PROXY_SOURCE_HEADER = 'x-antseed-system-proxy-source';
const CLAUDE_DESKTOP_SOURCE = 'claude-desktop';

/** Request headers forwarded to the buyer proxy verbatim. */
const FORWARDED_REQUEST_HEADERS = ['accept', 'anthropic-version', 'anthropic-beta', 'user-agent'] as const;
/** Hop-by-hop headers never copied onto the downstream response. */
const DROPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade']);

export type ClaudeDesktopGatewayOptions = {
  readonly port: number;
  readonly buyerPort: number;
  readonly log?: (line: string) => void;
  /** Curated picker models for the catalog slots; defaults to the shared
      source injected via setClaudeDesktopGatewayModelSource. */
  readonly listModels?: () => readonly ClaudeGatewayModel[];
  /** Where slot bindings persist. Claude caches the catalog across Antseed
      restarts, so a fresh gateway must keep meaning the same models for the
      ids Claude already knows — without this file every app restart would
      rebind slots from the current picker order and silently re-point them. */
  readonly stateFile?: string;
};

export class ClaudeDesktopGateway {
  private server: http.Server | null = null;
  private boundPort: number | null = null;
  /** Claude slot id → model to route, as last advertised by /v1/models. */
  private slotModels = new Map<string, string>();
  /** Claude slot id → display name last advertised for its model. */
  private slotLabels = new Map<string, string>();

  constructor(private readonly options: ClaudeDesktopGatewayOptions) {
    this.loadPersistedSlots();
  }

  private loadPersistedSlots(): void {
    if (!this.options.stateFile) return;
    try {
      const raw = JSON.parse(readFileSync(this.options.stateFile, 'utf8')) as Record<string, unknown>;
      for (const slot of CLAUDE_MODEL_SLOTS.slice(1)) {
        const entry = raw[slot.id];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const { model, label } = entry as Record<string, unknown>;
        if (typeof model !== 'string' || model.trim().length === 0) continue;
        this.slotModels.set(slot.id, model);
        this.slotLabels.set(slot.id, typeof label === 'string' && label.trim().length > 0 ? label : model);
      }
    } catch {
      // Missing or unreadable state — bindings start fresh.
    }
  }

  private persistSlots(): void {
    if (!this.options.stateFile) return;
    const state: Record<string, { model: string; label: string }> = {};
    for (const slot of CLAUDE_MODEL_SLOTS.slice(1)) {
      const model = this.slotModels.get(slot.id);
      if (!model) continue;
      state[slot.id] = { model, label: this.slotLabels.get(slot.id) ?? model };
    }
    try {
      mkdirSync(path.dirname(this.options.stateFile), { recursive: true });
      writeFileSync(this.options.stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    } catch {
      // Best-effort — bindings still hold for this process.
    }
  }

  /** The listening port — resolved from the socket when constructed with 0. */
  get port(): number {
    return this.boundPort ?? this.options.port;
  }

  get buyerPort(): number {
    return this.options.buyerPort;
  }

  get running(): boolean {
    return this.server?.listening === true;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => this.handleRequest(req, res));
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.close();
        reject((err as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? new Error(`Claude gateway port ${this.options.port} is already in use — close the other process or set ANTSEED_CLAUDE_GATEWAY_PORT.`)
          : err);
      };
      server.once('error', onError);
      server.listen(this.options.port, '127.0.0.1', () => {
        server.off('error', onError);
        const address = server.address();
        this.boundPort = address && typeof address === 'object' ? address.port : this.options.port;
        resolve();
      });
    });
    this.server = server;
    this.options.log?.(`Claude Desktop gateway listening on 127.0.0.1:${this.port} (buyer proxy on ${this.options.buyerPort})`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.allowsHost(req.headers.host)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    // Claude Desktop uses a native HTTP client, not a browser — any request
    // carrying an Origin is something else probing the loopback port.
    if (req.headers.origin) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const url = (req.url ?? '/').split('?')[0] ?? '/';
    if (url === CLAUDE_GATEWAY_HEALTH_PATH) {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      res.writeHead(204, { [CLAUDE_GATEWAY_HEALTH_HEADER]: '1' }).end();
      return;
    }
    if (url === '/v1/models') {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      this.serveModels(res);
      return;
    }
    if (url === '/v1/messages' || url === '/v1/messages/count_tokens') {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
      this.forwardMessages(req, res, url);
      return;
    }
    writeAnthropicError(res, 404, 'not_found_error', 'Not found');
  }

  /** Loopback host with our port only — a DNS-rebound page resolves to us but
      carries its own hostname, and must not reach the gateway. */
  private allowsHost(hostHeader: string | undefined): boolean {
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader ?? '');
    if (!match) return false;
    const host = match[1]!.replace(/^\[|\]$/g, '');
    if ((match[2] ?? '') !== String(this.port)) return false;
    if (host.toLowerCase() === 'localhost') return true;
    if (net.isIP(host) === 0) return false;
    return host === '::1' || host.startsWith('127.');
  }

  /**
   * Slot assignments: "Antseed Auto" always holds the first slot; curated
   * picker models occupy the rest. Bindings are sticky per model, not
   * positional: Claude caches the catalog it fetched, so the id it sends
   * with a message must keep meaning the model it displayed — a picker
   * reorder (selection change, favorites) must never silently re-point an
   * already-advertised id at a different model. A model keeps its slot while
   * it remains in the picker; slots whose model left become free for new
   * ones. Also refreshes the slot→model routing map used by forwardMessages.
   */
  private assignSlots(): { slot: typeof CLAUDE_MODEL_SLOTS[number]; label: string; model: string }[] {
    const listed = (this.options.listModels ?? sharedModelSource)?.() ?? [];
    const seen = new Set<string>();
    const labels = new Map<string, string>();
    const picks: string[] = [];
    for (const entry of listed) {
      const model = entry.model.trim();
      if (!model || seen.has(model)) continue;
      seen.add(model);
      labels.set(model, entry.label.trim() || model);
      picks.push(model);
    }

    const autoSlot = CLAUDE_MODEL_SLOTS[0]!;
    const assignableSlots = CLAUDE_MODEL_SLOTS.slice(1);
    const currentAssignments = () => {
      const assignments = [{ slot: autoSlot, label: CLAUDE_GATEWAY_MODEL_LABEL, model: ROUTED_MODEL_ALIAS }];
      for (const slot of assignableSlots) {
        const model = this.slotModels.get(slot.id);
        if (model) assignments.push({ slot, label: this.slotLabels.get(slot.id) ?? model, model });
      }
      return assignments;
    };

    // The renderer has not pushed the picker snapshot yet (fresh launch) —
    // keep whatever bindings persisted rather than wiping them and letting
    // Claude's cached catalog ids fall back to the Auto route.
    if (picks.length === 0) {
      this.slotModels.set(autoSlot.id, ROUTED_MODEL_ALIAS);
      return currentAssignments();
    }

    // Keep bindings whose model is still offered; the rest free their slot.
    const bindings = new Map<string, string>();
    for (const slot of assignableSlots) {
      const model = this.slotModels.get(slot.id);
      if (model && model !== ROUTED_MODEL_ALIAS && seen.has(model)) bindings.set(slot.id, model);
    }
    const boundModels = new Set(bindings.values());
    // A network model whose id matches a Claude slot id (the network does
    // offer Claude models) claims its namesake slot first, so the id Claude
    // sends means exactly that model.
    for (const model of picks) {
      if (boundModels.has(model)) continue;
      const ownSlot = assignableSlots.find((slot) => slot.id === model && !bindings.has(slot.id));
      if (!ownSlot) continue;
      bindings.set(ownSlot.id, model);
      boundModels.add(model);
    }
    // The rest fill the remaining free slots in picker order.
    for (const model of picks) {
      if (boundModels.has(model)) continue;
      const target = assignableSlots.find((slot) => !bindings.has(slot.id));
      if (!target) break;
      bindings.set(target.id, model);
      boundModels.add(model);
    }

    this.slotModels = new Map([[autoSlot.id, ROUTED_MODEL_ALIAS], ...bindings]);
    this.slotLabels = new Map(
      [...bindings].map(([slotId, model]) => [slotId, labels.get(model) ?? this.slotLabels.get(slotId) ?? model]),
    );
    this.persistSlots();
    return currentAssignments();
  }

  private serveModels(res: http.ServerResponse): void {
    const data = this.assignSlots().map(({ slot, label }) => ({
      id: slot.id,
      type: 'model',
      display_name: label,
      created_at: slot.createdAt,
      max_tokens: ANTSEED_MODEL_MAX_OUTPUT_TOKENS,
      anthropic_family_tier: slot.family,
      is_family_default: slot.familyDefault,
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
      has_more: false,
    }));
  }

  private forwardMessages(req: http.IncomingMessage, res: http.ServerResponse, url: string): void {
    collectBody(req, (err, body) => {
      if (err) {
        writeAnthropicError(res, err.statusCode, 'invalid_request_error', err.message);
        return;
      }
      this.forwardCollectedBody(req, res, url, body);
    });
  }

  private forwardCollectedBody(req: http.IncomingMessage, res: http.ServerResponse, url: string, body: Buffer): void {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        // Claude authenticates to this loopback gateway with the placeholder
        // key from its profile; never forward that credential upstream.
        'x-api-key': 'antseed',
        [SYSTEM_PROXY_SOURCE_HEADER]: CLAUDE_DESKTOP_SOURCE,
      };
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = req.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      // Claude may send a slot id from a catalog served before this process
      // started; make sure the slot map exists before resolving against it.
      if (this.slotModels.size === 0) this.assignSlots();
      // The routing note goes only on real message turns — count_tokens
      // never reaches a model.
      const payload = rewriteModel(body, this.slotModels, { routingNote: url === '/v1/messages' });
      headers['content-length'] = String(Buffer.byteLength(payload));
      const upstream = http.request(
        { host: '127.0.0.1', port: this.options.buyerPort, path: url, method: 'POST', headers },
        (upstreamRes) => {
          const responseHeaders: Record<string, string | string[]> = {};
          for (const [name, value] of Object.entries(upstreamRes.headers)) {
            if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders[name] = value;
          }
          res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
          upstreamRes.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        writeAnthropicError(res, 502, 'api_error', 'Antseed is not reachable — open the Antseed desktop app and try again.');
      });
      // A request's own 'close' fires once its body is consumed — only a
      // response that closes before finishing means Claude went away.
      res.on('close', () => {
        if (!res.writableEnded) upstream.destroy();
      });
      upstream.end(payload);
  }
}

/**
 * Rewrite the requested model to what its Claude slot id was advertised for,
 * falling back to the routed-model alias (the route picked in the desktop).
 * An explicit `<peerId>@<service>` pin and the alias itself pass through;
 * anything unparseable is forwarded verbatim so the buyer proxy produces the
 * meaningful error.
 *
 * With `routingNote`, a short note is appended to the system prompt saying
 * the conversation runs through the Antseed network. Claude Desktop's own
 * system prompt asserts a Claude identity the model trusts over anything a
 * gateway writes, so no identity correction is attempted — the note only
 * flags that infrastructure context may not reflect the serving model.
 */
export function rewriteModel(
  body: Buffer,
  slotModels: ReadonlyMap<string, string>,
  opts: { routingNote?: boolean } = {},
): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body;
  const request = parsed as Record<string, unknown>;
  const model = request['model'];
  const passthrough = typeof model === 'string' && (model === ROUTED_MODEL_ALIAS || model.includes('@'));
  if (passthrough && !opts.routingNote) return body;
  if (!passthrough) {
    request['model'] = (typeof model === 'string' ? slotModels.get(model) : undefined) ?? ROUTED_MODEL_ALIAS;
  }
  if (opts.routingNote) appendRoutingNote(request);
  return Buffer.from(JSON.stringify(request), 'utf8');
}

const ROUTING_NOTE = 'Note from Antseed: this conversation is delivered through the Antseed peer-to-peer '
  + 'network, not directly through Anthropic. Environment metadata comes from the Claude client '
  + 'infrastructure and may not describe the model actually serving the conversation.';

/** Appended as the last system block so earlier prompt-cache breakpoints
    Claude Desktop may have set stay valid. Unknown system shapes are left
    alone rather than guessed at. */
function appendRoutingNote(request: Record<string, unknown>): void {
  const note = ROUTING_NOTE;
  const system = request['system'];
  if (system === undefined || system === null) {
    request['system'] = note;
  } else if (typeof system === 'string') {
    request['system'] = `${system}\n\n${note}`;
  } else if (Array.isArray(system)) {
    request['system'] = [...system, { type: 'text', text: note }];
  }
}

type BodyError = Error & { statusCode: number };

function collectBody(req: http.IncomingMessage, done: (err: BodyError | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let finished = false;
  const finish = (err: BodyError | null, body: Buffer) => {
    if (finished) return;
    finished = true;
    done(err, body);
  };
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      req.destroy();
      finish(Object.assign(new Error('Request body too large'), { statusCode: 413 }), Buffer.alloc(0));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => finish(null, Buffer.concat(chunks)));
  req.on('error', () => finish(Object.assign(new Error('Request aborted'), { statusCode: 400 }), Buffer.alloc(0)));
}

function methodNotAllowed(res: http.ServerResponse, allow: string): void {
  res.writeHead(405, { allow }).end('method not allowed');
}

function writeAnthropicError(res: http.ServerResponse, statusCode: number, type: string, message: string): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

let activeGateway: ClaudeDesktopGateway | null = null;

/**
 * Start (or re-point) the singleton gateway. Kept in lockstep with the
 * `claude-desktop` profile's connect state by the system-proxy runtime.
 */
export async function ensureClaudeDesktopGateway(
  buyerPort: number,
  log?: (line: string) => void,
  stateFile?: string,
): Promise<void> {
  if (activeGateway?.running && activeGateway.buyerPort === buyerPort) return;
  await stopClaudeDesktopGateway();
  const gateway = new ClaudeDesktopGateway({
    port: CLAUDE_GATEWAY_DEFAULT_PORT,
    buyerPort,
    ...(log ? { log } : {}),
    ...(stateFile ? { stateFile } : {}),
  });
  await gateway.start();
  activeGateway = gateway;
}

export async function stopClaudeDesktopGateway(): Promise<void> {
  const gateway = activeGateway;
  activeGateway = null;
  await gateway?.stop();
}
