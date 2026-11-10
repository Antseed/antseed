import type {
  Provider,
  SerializedHttpRequest,
  SerializedHttpResponse,
  ProviderStreamCallbacks,
} from '@antseed/node';
import type { AntAgentDefinition } from './loader.js';
import type { AntAgentTool } from './tools.js';
import {
  type RequestFormat,
  detectRequestFormat,
  isToolChoiceForced,
  injectTools,
  inspectResponse,
  executeTools,
  appendToolLoop,
  stripInternalToolCalls,
} from './tools.js';
import { buildSystemPrompt, injectSystemPrompt } from './system-prompt.js';
import { parseSSEResponse } from './sse-parser.js';
import { TOOL_PREFIX } from './tools.js';
import { LoopUsage, type LoopProvider } from './usage.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const DEFAULT_MAX_ITERATIONS = 5;

export interface AgentLoopOptions {
  /** Maximum tool-call rounds before forcing a final request. Total LLM calls = maxIterations + 1. Default: 5. */
  maxIterations?: number;
  /** Additional tools available to the agent loop. Auto-prefixed with `antseed_`. */
  tools?: AntAgentTool[];
}

/** Agent definition paired with its pre-built tool list. Created once at construction. */
export interface ResolvedAgent {
  definition: AntAgentDefinition;
  tools: AntAgentTool[];
}

export type AgentResolver = (body: Record<string, unknown>) => ResolvedAgent | undefined;

function normalizeDebugValue(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function isDebugEnabled(): boolean {
  const fromAntseed = normalizeDebugValue(process.env['ANTSEED_DEBUG']);
  if (['1', 'true', 'yes', 'on'].includes(fromAntseed)) return true;

  return normalizeDebugValue(process.env['DEBUG'])
    .split(',')
    .some((ns) => {
      const trimmed = ns.trim();
      return trimmed === '*' || trimmed === 'antseed' || trimmed === 'antseed:*';
    });
}

const DEBUG_ENABLED = isDebugEnabled();

function debugLog(...args: unknown[]): void {
  if (DEBUG_ENABLED) console.log(...args);
}

/** Check if an SSE chunk contains an Anthropic message_start event. */
function chunkHasMessageStart(data: Uint8Array): boolean {
  const text = decoder.decode(data);
  return text.includes('event: message_start') || text.includes('"type":"message_start"') || text.includes('"type": "message_start"');
}

/** Check if an SSE chunk contains a Responses API response.created event. */
function chunkHasResponseCreated(data: Uint8Array): boolean {
  const text = decoder.decode(data);
  return text.includes('event: response.created');
}


/**
 * Check if an SSE chunk contains an internal (antseed_*) tool call.
 * Used during streaming to decide whether to forward chunks to the buyer.
 */
function chunkHasInternalToolCall(data: Uint8Array, format: RequestFormat): boolean {
  const text = decoder.decode(data);
  if (format === 'openai') {
    // OpenAI: look for "name":"antseed_" in tool_calls deltas
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      try {
        const chunk = JSON.parse(line.slice(6).trimEnd()) as Record<string, unknown>;
        const choices = chunk.choices as { delta?: { tool_calls?: { function?: { name?: string } }[] } }[] | undefined;
        const toolCalls = choices?.[0]?.delta?.tool_calls;
        if (toolCalls?.some(tc => tc.function?.name?.startsWith(TOOL_PREFIX))) return true;
      } catch { /* ignore */ }
    }
  } else {
    // Anthropic & Responses API: look for antseed_ name in content blocks or output items
    if (text.includes(`"name":"${TOOL_PREFIX}`) || text.includes(`"name": "${TOOL_PREFIX}`)) return true;
  }
  return false;
}

/** Prepare the request body: parse, resolve agent, inject system prompt + tools. */
function prepareBody(
  req: SerializedHttpRequest,
  resolve: AgentResolver,
): { body: Record<string, unknown>; agent: ResolvedAgent; reqTag: string } | null {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(decoder.decode(req.body)) as Record<string, unknown>;
  } catch {
    return null;
  }

  const agent = resolve(body);
  if (!agent) return null;

  const { definition, tools } = agent;
  const willInjectTools = tools.length > 0 && !isToolChoiceForced(body);
  const reqTag = `[AntAgent] ${req.method} ${req.path} (reqId=${req.requestId.slice(0, 8)})`;
  debugLog(`${reqTag}: resolved agent "${definition.name}" with ${tools.length} tool(s): ${tools.map(t => t.name).join(', ') || 'none'}${willInjectTools ? '' : ' (tools skipped)'}`);

  const systemPrompt = buildSystemPrompt(definition, willInjectTools);
  body = injectSystemPrompt(body, systemPrompt, detectRequestFormat(req.path));
  body = injectTools(body, tools, detectRequestFormat(req.path));

  return { body, agent, reqTag };
}

/**
 * Non-streaming agent loop. Runs tool iterations buffered, returns final response.
 * The response reports the token usage of every upstream call, not only the last.
 */
export async function runAgentLoop(
  inner: Provider,
  req: SerializedHttpRequest,
  resolve: AgentResolver,
  options?: AgentLoopOptions,
): Promise<SerializedHttpResponse> {
  const usage = new LoopUsage();
  return usage.total(await bufferedLoop(usage.meter(inner), req, resolve, options));
}

async function bufferedLoop(
  inner: LoopProvider,
  req: SerializedHttpRequest,
  resolve: AgentResolver,
  options?: AgentLoopOptions,
): Promise<SerializedHttpResponse> {
  const prepared = prepareBody(req, resolve);
  if (!prepared) return inner.handleRequest(req);

  const { agent, reqTag } = prepared;
  let { body } = prepared;
  const format = detectRequestFormat(req.path);
  const maxIterations = options?.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  // Force non-streaming for the buffered loop
  delete body.stream;

  for (let i = 0; i < maxIterations; i++) {
    debugLog(`${reqTag}: loop iteration ${i + 1}/${maxIterations}`);

    const augReq: SerializedHttpRequest = {
      ...req,
      body: encoder.encode(JSON.stringify(body)),
    };

    const response = await inner.handleRequest(augReq);

    let responseBody: Record<string, unknown>;
    try {
      responseBody = JSON.parse(decoder.decode(response.body)) as Record<string, unknown>;
    } catch {
      return response;
    }

    const action = inspectResponse(responseBody, format);
    if (action.type === 'done') {
      const cleaned = stripInternalToolCalls(responseBody, format);
      return { ...response, body: encoder.encode(JSON.stringify(cleaned)) };
    }

    debugLog(`${reqTag}: executing ${action.internalCalls.length} tool(s): ${action.internalCalls.map(c => c.name).join(', ')}`);
    const results = await executeTools(action.internalCalls, agent.tools);
    debugLog(`${reqTag}: tool results: ${results.map(r => `${r.id}:${r.isError ? 'error' : 'ok'}`).join(', ')}`);
    body = appendToolLoop(body, responseBody, results, format);
  }

  // Max iterations — one final call
  debugLog(`${reqTag}: max iterations (${maxIterations}) reached`);
  const finalReq: SerializedHttpRequest = {
    ...req,
    body: encoder.encode(JSON.stringify(body)),
  };
  const response = await inner.handleRequest(finalReq);
  try {
    const responseBody = JSON.parse(decoder.decode(response.body)) as Record<string, unknown>;
    const cleaned = stripInternalToolCalls(responseBody, format);
    return { ...response, body: encoder.encode(JSON.stringify(cleaned)) };
  } catch {
    return response;
  }
}

/**
 * Streaming agent loop. Every LLM call streams to the buyer in real time.
 * Tool calls are intercepted at the end of each stream, executed, and the
 * next iteration streams again — so the buyer sees tokens arriving live
 * throughout the entire conversation.
 *
 * The usage events the buyer receives and the returned response report the
 * token usage of every upstream call, not only the last.
 */
export async function runAgentLoopStream(
  inner: Provider,
  req: SerializedHttpRequest,
  resolve: AgentResolver,
  callbacks: ProviderStreamCallbacks,
  options?: AgentLoopOptions,
): Promise<SerializedHttpResponse> {
  const usage = new LoopUsage();
  return usage.total(await streamingLoop(usage.meter(inner), req, resolve, usage.forward(callbacks), options));
}

async function streamingLoop(
  inner: LoopProvider,
  req: SerializedHttpRequest,
  resolve: AgentResolver,
  callbacks: ProviderStreamCallbacks,
  options?: AgentLoopOptions,
): Promise<SerializedHttpResponse> {
  const prepared = prepareBody(req, resolve);
  if (!prepared) return inner.handleRequestStream!(req, callbacks);

  const { agent, reqTag } = prepared;
  let { body } = prepared;
  const format = detectRequestFormat(req.path);
  const maxIterations = options?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  let headersSent = false;
  let messageStartSent = false;

  for (let i = 0; i < maxIterations; i++) {
    debugLog(`${reqTag}: stream iteration ${i + 1}/${maxIterations}`);

    const isLastAllowedIteration = i === maxIterations - 1;
    const augReq: SerializedHttpRequest = {
      ...req,
      body: encoder.encode(JSON.stringify({ ...body, stream: true })),
    };

    // Stream the call, forwarding chunks to the buyer.
    // For Anthropic format: suppress message_start on non-first iterations and
    // message_stop on non-final iterations to maintain one continuous SSE envelope.
    // For both formats: suppress antseed_* tool call chunks.
    let streamResponse: SerializedHttpResponse;
    let suppressingChunks = false;
    try {
      streamResponse = await inner.handleRequestStream!(augReq, {
        onResponseStart: (res) => {
          if (!headersSent) {
            callbacks.onResponseStart(res);
            headersSent = true;
          }
        },
        onResponseChunk: (chunk) => {
          if (suppressingChunks) return;
          if (!chunk.done && chunk.data.length > 0) {
            // Check if this chunk reveals an internal tool call
            if (chunkHasInternalToolCall(chunk.data, format)) {
              suppressingChunks = true;
              return;
            }
            if (format === 'anthropic' && chunkHasMessageStart(chunk.data)) {
              // Suppress message_start if we already sent one (one continuous envelope)
              if (messageStartSent) return;
              messageStartSent = true;
            }
            if (format === 'openai-responses' && chunkHasResponseCreated(chunk.data)) {
              if (messageStartSent) return;
              messageStartSent = true;
            }
          }
          callbacks.onResponseChunk(chunk);
        },
      });
    } catch (err) {
      // If streaming fails, try non-streaming fallback with tool call stripping
      debugLog(`${reqTag}: stream failed, falling back to non-streaming`);
      const augReqNonStream: SerializedHttpRequest = {
        ...req,
        body: encoder.encode(JSON.stringify({ ...body, stream: false })),
      };
      const response = await inner.handleRequest(augReqNonStream);
      let responseBody: Uint8Array = response.body;
      try {
        const parsed = JSON.parse(decoder.decode(response.body)) as Record<string, unknown>;
        const cleaned = stripInternalToolCalls(parsed, format);
        responseBody = encoder.encode(JSON.stringify(cleaned));
      } catch { /* non-JSON — use as-is */ }
      const cleanedResponse = { ...response, body: responseBody };
      if (!headersSent) {
        callbacks.onResponseStart(cleanedResponse);
        headersSent = true;
      }
      callbacks.onResponseChunk({ requestId: req.requestId, data: responseBody, done: true });
      return cleanedResponse;
    }

    // Parse the buffered SSE response to check for tool calls
    let responseBody: Record<string, unknown>;
    try {
      responseBody = parseSSEResponse(streamResponse.body, format);
    } catch {
      // Can't parse — treat as done
      return streamResponse;
    }

    const action = inspectResponse(responseBody, format);
    if (action.type === 'done') {
      if (suppressingChunks) {
        // We suppressed chunks (detected internal tool call) but inspectResponse
        // resolved as done (e.g. mixed buyer+internal calls). Close the buyer's stream.
        callbacks.onResponseChunk({ requestId: req.requestId, data: new Uint8Array(0), done: true });
      }
      debugLog(`${reqTag}: stream iteration ${i + 1} done (no internal tool calls)`);
      return streamResponse;
    }

    // Internal tool calls found — execute them
    debugLog(`${reqTag}: stream iteration ${i + 1} — executing ${action.internalCalls.length} tool(s): ${action.internalCalls.map(c => c.name).join(', ')}`);
    const results = await executeTools(action.internalCalls, agent.tools);
    debugLog(`${reqTag}: stream iteration ${i + 1} — tool results: ${results.map(r => `${r.id}:${r.isError ? 'error' : 'ok'}`).join(', ')}`);
    body = appendToolLoop(body, responseBody, results, format);

    // If this was the last allowed iteration, break to make a final streaming call
    if (isLastAllowedIteration) {
      debugLog(`${reqTag}: max iterations (${maxIterations}) reached, making final streaming call`);
      break;
    }
  }

  // Final streaming call after max iterations (or maxIterations=0)
  const finalReq: SerializedHttpRequest = {
    ...req,
    body: encoder.encode(JSON.stringify({ ...body, stream: true })),
  };
  return inner.handleRequestStream!(finalReq, {
    onResponseStart: (res) => {
      if (!headersSent) {
        callbacks.onResponseStart(res);
      }
    },
    onResponseChunk: (chunk) => {
      if (!chunk.done && chunk.data.length > 0) {
        // Anthropic: suppress message_start if we already sent one (continuing the envelope)
        if (format === 'anthropic' && messageStartSent && chunkHasMessageStart(chunk.data)) return;
        // Responses API: suppress response.created if we already sent one
        if (format === 'openai-responses' && messageStartSent && chunkHasResponseCreated(chunk.data)) return;
      }
      callbacks.onResponseChunk(chunk);
    },
  });
}
