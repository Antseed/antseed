import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import type {
  AntseedProviderPlugin,
  Provider,
  SerializedHttpRequest,
  SerializedHttpResponse,
  ServiceApiProtocol,
  TokenProvider,
  TokenProviderState,
} from '@antseed/node';
import {
  BaseProvider,
  DEFAULT_HTTP_TIMEOUT_MS,
  buildServiceApiProtocols,
  parseCsv,
  parseNonNegativeNumber,
  parseServiceAliasMap,
  parseServiceCapabilitiesJson,
  parseServicePricingJson,
} from '@antseed/provider-core';

const DEFAULT_AUTH_FILE = '~/.codex/auth.json';
const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_INPUT_PRICE = 10;
const DEFAULT_OUTPUT_PRICE = 10;
const DEFAULT_MAX_CONCURRENCY = 50;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = DEFAULT_HTTP_TIMEOUT_MS;
const RESPONSE_PATH_PREFIX = '/v1/responses';
const RELAY_PATH = '/responses';
const AUTH_CLAIM_PATH = 'https://api.openai.com/auth';
const CLIENT_STREAM_REQUESTED_HEADER = 'x-antseed-client-stream-requested';

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

interface AuthFileShape {
  OPENAI_API_KEY?: unknown;
  tokens?: {
    access_token?: unknown;
    refresh_token?: unknown;
    id_token?: unknown;
    account_id?: unknown;
  };
  last_refresh?: unknown;
}

interface AuthContext {
  accessToken: string;
  refreshToken?: string;
  accountId: string;
  expiresAt?: number;
  idToken?: string;
}

interface LoadedAuthContext {
  auth: AuthContext;
  persisted: AuthFileShape;
}

interface CodexTokenProviderState extends TokenProviderState {
  accountId?: string;
  idToken?: string;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  const payload = parts[1];
  if (!payload) return null;

  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseAuthContext(parsed: AuthFileShape, authFilePath: string): AuthContext {
  const accessToken = typeof parsed.tokens?.access_token === 'string'
    ? parsed.tokens.access_token.trim()
    : '';

  if (!accessToken) {
    throw new Error(`Codex auth file at ${authFilePath} is missing tokens.access_token`);
  }

  const payload = decodeJwtPayload(accessToken);
  const jwtAccountId = payload
    && payload[AUTH_CLAIM_PATH]
    && typeof payload[AUTH_CLAIM_PATH] === 'object'
    && !Array.isArray(payload[AUTH_CLAIM_PATH])
    && typeof (payload[AUTH_CLAIM_PATH] as Record<string, unknown>)['chatgpt_account_id'] === 'string'
    ? ((payload[AUTH_CLAIM_PATH] as Record<string, unknown>)['chatgpt_account_id'] as string).trim()
    : '';
  const authFileAccountId = typeof parsed.tokens?.account_id === 'string'
    ? parsed.tokens.account_id.trim()
    : '';
  const accountId = jwtAccountId || authFileAccountId;

  if (!accountId) {
    throw new Error(
      `Codex auth file at ${authFilePath} is missing tokens.account_id and the JWT lacks ${AUTH_CLAIM_PATH}.chatgpt_account_id`,
    );
  }

  const refreshToken = typeof parsed.tokens?.refresh_token === 'string'
    ? parsed.tokens.refresh_token.trim()
    : undefined;
  const idToken = typeof parsed.tokens?.id_token === 'string'
    ? parsed.tokens.id_token.trim()
    : undefined;
  const expiresAt = getJwtExpiration(accessToken);

  return { accessToken, refreshToken, accountId, expiresAt, idToken };
}

function readAuthContext(authFilePath: string): AuthContext {
  return loadAuthContext(authFilePath).auth;
}

function loadAuthContext(authFilePath: string): LoadedAuthContext {
  const raw = readFileSync(authFilePath, 'utf8');
  const parsed = JSON.parse(raw) as AuthFileShape;
  return {
    auth: parseAuthContext(parsed, authFilePath),
    persisted: parsed,
  };
}

function getJwtExpiration(token: string): number | undefined {
  const payload = decodeJwtPayload(token);
  const exp = payload?.['exp'];
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) {
    return undefined;
  }
  return exp * 1000;
}

function isAuthExpiringSoon(auth: AuthContext): boolean {
  return auth.expiresAt !== undefined && Date.now() >= auth.expiresAt - REFRESH_BUFFER_MS;
}

function writeAuthContext(authFilePath: string, persisted: AuthFileShape, auth: AuthContext): void {
  const next: AuthFileShape = {
    ...persisted,
    tokens: {
      ...persisted.tokens,
      access_token: auth.accessToken,
      ...(auth.refreshToken ? { refresh_token: auth.refreshToken } : {}),
      ...(auth.idToken ? { id_token: auth.idToken } : {}),
      account_id: auth.accountId,
    },
    last_refresh: new Date().toISOString(),
  };

  const tempPath = `${authFilePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tempPath, authFilePath);
}

async function refreshAuthContext(authFilePath: string): Promise<AuthContext> {
  const { auth: current, persisted } = loadAuthContext(authFilePath);
  if (!current.refreshToken) {
    throw new Error(`Codex auth file at ${authFilePath} is missing tokens.refresh_token`);
  }

  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        client_id: OPENAI_CLIENT_ID,
      }),
      signal: timeoutSignal,
    });
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new Error(`OpenAI Codex token refresh timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw error;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI Codex token refresh failed (${response.status}): ${text}`);
  }

  const json = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    id_token?: unknown;
  };

  const accessToken = typeof json.access_token === 'string' ? json.access_token.trim() : '';
  const refreshToken = typeof json.refresh_token === 'string'
    ? json.refresh_token.trim()
    : current.refreshToken;
  const idToken = typeof json.id_token === 'string' ? json.id_token.trim() : current.idToken;

  if (!accessToken) {
    throw new Error('OpenAI Codex token refresh response missing access_token');
  }

  const refreshed: AuthContext = {
    accessToken,
    refreshToken,
    accountId: extractAccountIdFromTokens(accessToken, idToken, current.accountId),
    expiresAt: getExpiresAtFromRefreshResponse(accessToken, json.expires_in),
    ...(idToken ? { idToken } : {}),
  };

  writeAuthContext(authFilePath, persisted, refreshed);
  return refreshed;
}

function getExpiresAtFromRefreshResponse(accessToken: string, expiresIn: unknown): number | undefined {
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
    return Date.now() + expiresIn * 1000;
  }
  return getJwtExpiration(accessToken);
}

function extractAccountIdFromTokens(accessToken: string, idToken: string | undefined, fallbackAccountId: string): string {
  const accessPayload = decodeJwtPayload(accessToken);
  const accessAccountId = accessPayload
    && accessPayload[AUTH_CLAIM_PATH]
    && typeof accessPayload[AUTH_CLAIM_PATH] === 'object'
    && !Array.isArray(accessPayload[AUTH_CLAIM_PATH])
    && typeof (accessPayload[AUTH_CLAIM_PATH] as Record<string, unknown>)['chatgpt_account_id'] === 'string'
    ? ((accessPayload[AUTH_CLAIM_PATH] as Record<string, unknown>)['chatgpt_account_id'] as string).trim()
    : '';

  if (accessAccountId) return accessAccountId;

  if (idToken) {
    const idPayload = decodeJwtPayload(idToken);
    const idAccountId = idPayload
      && idPayload[AUTH_CLAIM_PATH]
      && typeof idPayload[AUTH_CLAIM_PATH] === 'object'
      && !Array.isArray(idPayload[AUTH_CLAIM_PATH])
      && typeof (idPayload[AUTH_CLAIM_PATH] as Record<string, unknown>)['chatgpt_account_id'] === 'string'
      ? ((idPayload[AUTH_CLAIM_PATH] as Record<string, unknown>)['chatgpt_account_id'] as string).trim()
      : '';
    if (idAccountId) return idAccountId;
  }

  return fallbackAccountId;
}

function prepareRequestBody(
  request: SerializedHttpRequest,
  serviceRewriteMap: Record<string, string> | undefined,
): { request: SerializedHttpRequest; forcedStream: boolean } {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return { request, forcedStream: false };
  }

  const normalizedPath = request.path.split('?')[0] ?? request.path;
  if (normalizedPath !== RESPONSE_PATH_PREFIX) {
    return { request, forcedStream: false };
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>;
    parsed.store ??= false;
    const clientStreamRequested = parseClientStreamRequestedHeader(request.headers);
    const forcedStream = clientStreamRequested === false || parsed.stream !== true;
    parsed.stream = true;

    const requestedService = (parsed.model ?? parsed.service) as string | undefined;
    if (serviceRewriteMap && typeof requestedService === 'string' && requestedService.trim().length > 0) {
      const rewritten = serviceRewriteMap[requestedService.trim().toLowerCase()];
      if (rewritten && rewritten.trim().length > 0) {
        parsed.model = rewritten.trim();
      }
    }

    if (parsed.service !== undefined && parsed.model === undefined) {
      parsed.model = parsed.service;
    }
    delete parsed.service;

    // Strip parameters the upstream backend doesn't support.
    delete parsed.metadata;
    delete parsed.user;
    delete parsed.max_output_tokens;
    delete parsed.temperature;
    delete parsed.top_p;

    // The upstream backend requires `instructions` as a top-level field.
    // Some clients (e.g. pi's openai-responses provider) send the system
    // prompt as a developer/system message in `input` instead. Extract it
    // and move to `instructions` so the request is accepted.
    if (!parsed.instructions && Array.isArray(parsed.input)) {
      const input = parsed.input as Array<Record<string, unknown>>;
      const sysIdx = input.findIndex((m) => m.role === 'system' || m.role === 'developer');
      if (sysIdx >= 0) {
        const sysMsg = input[sysIdx]!;
        let instructionText: string;
        if (typeof sysMsg.content === 'string') {
          instructionText = sysMsg.content;
        } else if (Array.isArray(sysMsg.content)) {
          instructionText = (sysMsg.content as Array<{ type?: string; text?: string }>)
            .filter((c) => c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text as string)
            .join('');
        } else {
          instructionText = '';
        }
        parsed.instructions = instructionText;
        input.splice(sysIdx, 1);
      }
    }

    return {
      request: {
        ...request,
        headers: withoutHeader(request.headers, CLIENT_STREAM_REQUESTED_HEADER),
        body: new TextEncoder().encode(JSON.stringify(parsed)),
      },
      forcedStream,
    };
  } catch {
    return { request, forcedStream: false };
  }
}

function parseClientStreamRequestedHeader(headers: Record<string, string>): boolean | undefined {
  const value = getHeader(headers, CLIENT_STREAM_REQUESTED_HEADER);
  if (!value) return undefined;
  return value.toLowerCase() === 'true';
}

function getHeader(headers: Record<string, string>, name: string): string {
  const normalizedName = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === normalizedName) return value;
  }
  return '';
}

function withoutHeader(headers: Record<string, string>, name: string): Record<string, string> {
  const normalizedName = name.toLowerCase();
  const next: Record<string, string> = {};
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() !== normalizedName) next[headerName] = value;
  }
  return next;
}

function collapseResponsesSseResponse(response: SerializedHttpResponse): SerializedHttpResponse {
  const result = parseResponsesSse(new TextDecoder().decode(response.body));
  if (!result) {
    return response;
  }

  return {
    ...response,
    statusCode: result.statusCode ?? response.statusCode,
    headers: {
      ...response.headers,
      'content-type': 'application/json',
    },
    body: new TextEncoder().encode(JSON.stringify(result.body)),
  };
}

function parseResponsesSse(text: string): { body: Record<string, unknown>; statusCode?: number } | null {
  const outputItems: Array<Record<string, unknown> | undefined> = [];

  for (const block of text.replace(/\r\n/g, '\n').split('\n\n')) {
    const lines = block.split('\n');
    const event = lines
      .find((line) => line.startsWith('event: '))
      ?.slice('event: '.length)
      .trim();
    if (
      event !== 'response.completed'
      && event !== 'response.failed'
      && event !== 'error'
      && event !== 'response.output_item.done'
    ) {
      continue;
    }

    const data = lines
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') continue;

    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (event === 'response.output_item.done') {
        const item = parsed.item;
        const outputIndex = parsed.output_index;
        if (typeof outputIndex === 'number' && Number.isInteger(outputIndex) && outputIndex >= 0
          && item && typeof item === 'object' && !Array.isArray(item)) {
          outputItems[outputIndex] = item as Record<string, unknown>;
        }
        continue;
      }

      if (event === 'error') {
        return { body: normalizeUpstreamStreamError(parsed), statusCode: 502 };
      }

      const nested = parsed.response;
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        const body = nested as Record<string, unknown>;
        if (event === 'response.failed') {
          return { body: normalizeUpstreamStreamError(body), statusCode: 502 };
        }
        const completedOutput = outputItems.filter(
          (item): item is Record<string, unknown> => item !== undefined,
        );
        if (completedOutput.length > 0 && (!Array.isArray(body.output) || body.output.length === 0)) {
          return { body: { ...body, output: completedOutput } };
        }
        return { body };
      }

      if (event === 'response.failed') {
        return { body: normalizeUpstreamStreamError(parsed), statusCode: 502 };
      }

      if (Array.isArray(parsed.output) || typeof parsed.output_text === 'string') {
        return { body: parsed };
      }
    } catch {
      continue;
    }
  }

  return null;
}

function normalizeUpstreamStreamError(payload: Record<string, unknown>): Record<string, unknown> {
  const error = payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error)
    ? payload.error as Record<string, unknown>
    : {};
  const message = typeof error.message === 'string'
    ? error.message
    : (typeof payload.message === 'string' ? payload.message : 'Responses stream failed');
  const type = typeof error.type === 'string'
    ? error.type
    : (typeof payload.type === 'string' ? payload.type : 'api_error');
  return {
    error: {
      ...error,
      type,
      message,
    },
  };
}

function toRelayPath(path: string): string | null {
  if (!path.startsWith(RESPONSE_PATH_PREFIX)) return null;
  return `${RELAY_PATH}${path.slice(RESPONSE_PATH_PREFIX.length)}`;
}

function buildError(requestId: string, statusCode: number, error: string): SerializedHttpResponse {
  return {
    requestId,
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ error })),
  };
}

class CodexAuthTokenProvider implements TokenProvider {
  private authContext: AuthContext | null = null;
  private refreshPromise: Promise<AuthContext> | null = null;

  constructor(private readonly authFilePath: string) {}

  async getToken(): Promise<string> {
    if (!this.authContext) {
      this.authContext = readAuthContext(this.authFilePath);
    }
    if (isAuthExpiringSoon(this.authContext)) {
      this.authContext = await this.refresh();
    }
    return this.authContext.accessToken;
  }

  async forceRefresh(): Promise<string> {
    this.authContext = await this.refresh();
    return this.authContext.accessToken;
  }

  stop(): void {}

  getState(): CodexTokenProviderState {
    return {
      accessToken: this.authContext?.accessToken ?? '',
      ...(this.authContext?.refreshToken ? { refreshToken: this.authContext.refreshToken } : {}),
      ...(this.authContext?.expiresAt ? { expiresAt: this.authContext.expiresAt } : {}),
      ...(this.authContext?.accountId ? { accountId: this.authContext.accountId } : {}),
      ...(this.authContext?.idToken ? { idToken: this.authContext.idToken } : {}),
    };
  }

  private async refresh(): Promise<AuthContext> {
    if (!this.refreshPromise) {
      this.refreshPromise = refreshAuthContext(this.authFilePath).finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }
}

class OpenAIResponsesProvider implements Provider {
  readonly name: string;
  readonly services: string[];
  readonly pricing: Provider['pricing'];
  readonly serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;
  readonly serviceCapabilities?: Provider['serviceCapabilities'];
  readonly maxConcurrency: number;

  private readonly inner: BaseProvider;
  private readonly serviceRewriteMap?: Record<string, string>;

  constructor(config: {
    name: string;
    services: string[];
    pricing: Provider['pricing'];
    serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;
    serviceCapabilities?: Provider['serviceCapabilities'];
    maxConcurrency: number;
    baseUrl: string;
    authFilePath: string;
    serviceRewriteMap?: Record<string, string>;
  }) {
    this.name = config.name;
    this.services = config.services;
    this.pricing = config.pricing;
    this.serviceApiProtocols = config.serviceApiProtocols;
    this.serviceCapabilities = config.serviceCapabilities;
    this.maxConcurrency = config.maxConcurrency;
    this.serviceRewriteMap = config.serviceRewriteMap;

    const tokenProvider = new CodexAuthTokenProvider(config.authFilePath);
    const relayBaseUrl = `${config.baseUrl.replace(/\/+$/, '')}/codex`;
    const relayAllowedServices = [
      ...config.services,
      ...Object.values(config.serviceRewriteMap ?? {}),
    ];
    this.inner = new BaseProvider({
      name: config.name,
      services: relayAllowedServices,
      pricing: config.pricing,
      ...(config.serviceApiProtocols ? { serviceApiProtocols: config.serviceApiProtocols } : {}),
      ...(config.serviceCapabilities ? { serviceCapabilities: config.serviceCapabilities } : {}),
      relay: {
        baseUrl: relayBaseUrl,
        authHeaderName: 'authorization',
        authHeaderValue: 'Bearer ignored',
        tokenProvider,
        extraHeaders: {
          'accept': 'text/event-stream',
          'openai-beta': 'responses=experimental',
        },
        extraHeadersProvider: async () => {
          const state = tokenProvider.getState() as CodexTokenProviderState | null;
          if (!state?.accountId) {
            return undefined;
          }
          return {
            'chatgpt-account-id': state.accountId,
          };
        },
        maxConcurrency: config.maxConcurrency,
        allowedServices: relayAllowedServices,
        timeoutMs: FETCH_TIMEOUT_MS,
        retryOn401: true,
        retryOn5xx: 3,
        retryBaseDelayMs: 1000,
        retryStatusCodes: [429],
      },
    });
  }

  async init(): Promise<void> {
    await this.inner.init();
  }

  getCapacity(): { current: number; max: number } {
    return this.inner.getCapacity();
  }

  async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    const prepared = this.prepareRequest(req);
    if ('response' in prepared) {
      return prepared.response;
    }
    const response = await this.inner.handleRequest(prepared.request);
    return prepared.forcedStream ? collapseResponsesSseResponse(response) : response;
  }

  async handleRequestStream(
    req: SerializedHttpRequest,
    callbacks: Parameters<NonNullable<Provider['handleRequestStream']>>[1],
  ): Promise<SerializedHttpResponse> {
    const prepared = this.prepareRequest(req);
    if ('response' in prepared) {
      callbacks.onResponseStart(prepared.response);
      callbacks.onResponseChunk({
        requestId: prepared.response.requestId,
        data: prepared.response.body,
        done: true,
      });
      return prepared.response;
    }
    if (prepared.forcedStream) {
      return collapseResponsesSseResponse(await this.inner.handleRequest(prepared.request));
    }
    return this.inner.handleRequestStream!(prepared.request, callbacks);
  }

  private prepareRequest(
    req: SerializedHttpRequest,
  ): { request: SerializedHttpRequest; forcedStream: boolean } | { response: SerializedHttpResponse } {
    const normalizedPath = req.path.split('?')[0] ?? req.path;
    const relayPath = toRelayPath(req.path);
    if (!relayPath) {
      return { response: buildError(req.requestId, 404, `Unsupported path: ${normalizedPath}`) };
    }

    const preparedBody = prepareRequestBody(req, this.serviceRewriteMap);
    return {
      request: {
        ...preparedBody.request,
        path: relayPath,
      },
      forcedStream: preparedBody.forcedStream,
    };
  }
}

const plugin: AntseedProviderPlugin = {
  name: 'openai-responses',
  displayName: 'OpenAI Responses',
  version: '0.1.0',
  type: 'provider',
  description: 'OpenAI Responses provider using Codex backend auth (testing only)',
  configSchema: [
    { key: 'OPENAI_RESPONSES_AUTH_FILE', label: 'Auth File', type: 'string', required: false, default: DEFAULT_AUTH_FILE, description: 'Path to ~/.codex/auth.json' },
    { key: 'OPENAI_RESPONSES_BASE_URL', label: 'Base URL', type: 'string', required: false, default: DEFAULT_BASE_URL, description: 'Codex backend base URL' },
    { key: 'ANTSEED_INPUT_USD_PER_MILLION', label: 'Input Price', type: 'number', required: false, default: DEFAULT_INPUT_PRICE, description: 'Input price in USD per 1M tokens' },
    { key: 'ANTSEED_OUTPUT_USD_PER_MILLION', label: 'Output Price', type: 'number', required: false, default: DEFAULT_OUTPUT_PRICE, description: 'Output price in USD per 1M tokens' },
    { key: 'ANTSEED_CACHED_INPUT_USD_PER_MILLION', label: 'Cached Input Price', type: 'number', required: false, description: 'Cached input price in USD per 1M tokens (defaults to input price)' },
    { key: 'ANTSEED_SERVICE_PRICING_JSON', label: 'Service Pricing JSON', type: 'string', required: false, description: 'Per-service pricing JSON' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Max Concurrency', type: 'number', required: false, default: DEFAULT_MAX_CONCURRENCY, description: 'Max concurrent requests' },
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Allowed Services', type: 'string[]', required: false, description: 'Service allow-list' },
    { key: 'ANTSEED_SERVICE_ALIAS_MAP_JSON', label: 'Service Alias Map', type: 'string', required: false, description: 'JSON map of announced service -> upstream model name' },
    { key: 'ANTSEED_SERVICE_CAPABILITIES_JSON', label: 'Service Capabilities JSON', type: 'string', required: false, description: 'Per-service model capability JSON' },
  ],

  createProvider(config: Record<string, string>): Provider {
    const servicePricing = parseServicePricingJson(config['ANTSEED_SERVICE_PRICING_JSON']);
    const pricing: Provider['pricing'] = {
      defaults: {
        inputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_INPUT_USD_PER_MILLION'], 'ANTSEED_INPUT_USD_PER_MILLION', DEFAULT_INPUT_PRICE),
        outputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_OUTPUT_USD_PER_MILLION'], 'ANTSEED_OUTPUT_USD_PER_MILLION', DEFAULT_OUTPUT_PRICE),
        ...(config['ANTSEED_CACHED_INPUT_USD_PER_MILLION'] ? { cachedInputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_CACHED_INPUT_USD_PER_MILLION'], 'ANTSEED_CACHED_INPUT_USD_PER_MILLION', 0) } : {}),
      },
      ...(servicePricing ? { services: servicePricing } : {}),
    };

    const maxConcurrency = parseInt(config['ANTSEED_MAX_CONCURRENCY'] ?? String(DEFAULT_MAX_CONCURRENCY), 10);
    if (Number.isNaN(maxConcurrency) || maxConcurrency <= 0) {
      throw new Error('ANTSEED_MAX_CONCURRENCY must be a positive number');
    }

    const allowedServices = parseCsv(config['ANTSEED_ALLOWED_SERVICES']);
    const authFilePath = expandHome(config['OPENAI_RESPONSES_AUTH_FILE']?.trim() || DEFAULT_AUTH_FILE);
    const baseUrl = config['OPENAI_RESPONSES_BASE_URL']?.trim() || DEFAULT_BASE_URL;
    const serviceRewriteMap = parseServiceAliasMap(config['ANTSEED_SERVICE_ALIAS_MAP_JSON']);
    const serviceCapabilities = parseServiceCapabilitiesJson(config['ANTSEED_SERVICE_CAPABILITIES_JSON']);
    const serviceApiProtocols = buildServiceApiProtocols(allowedServices, 'openai-responses');

    return new OpenAIResponsesProvider({
      name: 'openai-responses',
      services: allowedServices,
      pricing,
      ...(serviceApiProtocols ? { serviceApiProtocols } : {}),
      ...(serviceCapabilities ? { serviceCapabilities } : {}),
      maxConcurrency,
      baseUrl,
      authFilePath,
      ...(serviceRewriteMap ? { serviceRewriteMap } : {}),
    });
  },
};

export default plugin;

export type { AuthContext };
export {
  decodeJwtPayload,
  expandHome,
  getJwtExpiration,
  isAuthExpiringSoon,
  readAuthContext,
  refreshAuthContext,
  writeAuthContext,
};
