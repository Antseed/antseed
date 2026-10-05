import {
  extractUsage,
  mapFinishReasonToAnthropicStopReason,
  openAIResponsesFunctionCallId,
  openAIResponsesMessageId,
  parseJsonSafe,
  RESPONSES_FINAL_ANSWER_TOOL,
  toStringContent,
  type TokenUsage,
} from './utils.js';

const RESPONSES_FINAL_ANSWER_TOOL_RE = /(?:^|\n\s*)tool\s+final_answer\s*\{\s*\}\s*(?:\n|$)/g;

export interface CanonicalFunctionTool {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export type CanonicalToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; name: string };

// Anthropic requires max_tokens; the OpenAI protocols treat it as optional.
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 16_384;

export type CanonicalContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url?: string; mediaType?: string; data?: string };

export type CanonicalResponseMessagePhase = 'commentary' | 'final_answer';

export type CanonicalInputItem =
  | {
    type: 'message';
    role: 'user' | 'assistant';
    content: CanonicalContentPart[];
    phase?: CanonicalResponseMessagePhase;
  }
  | { type: 'function_call'; id: string; name: string; arguments: Record<string, unknown> | string }
  | { type: 'function_call_output'; callId: string; output: string };

/**
 * Where a prompt prefix ends and may be cached by the seller's upstream.
 *
 * Only Anthropic expresses this in the request (`cache_control` markers); the
 * OpenAI protocols cache prefixes automatically. Carrying the positions
 * through canonical form lets an Anthropic client's own breakpoints survive a
 * round trip, and lets a request that arrived without any get a standard set
 * on the way out to an Anthropic seller — which otherwise caches nothing.
 */
export interface CanonicalCacheBreakpoints {
  /** End the cacheable prefix after the system prompt. */
  instructions: boolean;
  /** End it after the tool definitions. */
  tools: boolean;
  /** Indices into `input` after which the prefix may be cached. */
  inputIndices: number[];
}

export interface CanonicalLlmRequest {
  model: string | null;
  stream: boolean;
  instructions?: string;
  input: CanonicalInputItem[];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string | string[];
  tools?: CanonicalFunctionTool[];
  toolChoice?: CanonicalToolChoice;
  metadata?: Record<string, unknown>;
  user?: string;
  promptCacheKey?: string;
  cacheBreakpoints?: CanonicalCacheBreakpoints;
}

function assignToolsAndToolChoice(
  body: Record<string, unknown>,
  tools: unknown[] | undefined,
  toolChoice: unknown,
): void {
  if (!tools || tools.length === 0) return;
  body.tools = tools;
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
}

export type CanonicalOutputItem =
  | { type: 'text'; text: string; phase?: CanonicalResponseMessagePhase }
  | { type: 'function_call'; id: string; name: string; arguments: Record<string, unknown> | string };

export interface CanonicalLlmResponse {
  id: string;
  model: string;
  output: CanonicalOutputItem[];
  stopReason: string | null;
  endTurn?: boolean;
  usage: TokenUsage;
}

function responseFunctionCallId(id: string): string {
  return id.startsWith('fc_') ? id : `fc_${id}`;
}

function chatFunctionCallId(id: string): string {
  return id.startsWith('fc_') ? id.slice(3) : id;
}

function toolParameters(parameters: unknown): Record<string, unknown> {
  return parameters && typeof parameters === 'object' && !Array.isArray(parameters)
    ? parameters as Record<string, unknown>
    : { type: 'object', properties: {} };
}

export function renderCanonicalRequestToOpenAIChatBody(
  request: CanonicalLlmRequest,
  options: {
    toolCallContent?: '' | null;
    groupAssistantToolCallsWithPreviousMessage?: boolean;
    preserveResponsesAgentSemantics?: boolean;
  } = {},
): Record<string, unknown> {
  const messages: unknown[] = [];
  const instructions = options.preserveResponsesAgentSemantics && request.tools?.length
    ? appendResponsesChatCompatibilityInstructions(request.instructions)
    : request.instructions;
  if (instructions !== undefined && instructions.length > 0) {
    messages.push({ role: 'system', content: instructions });
  }

  for (const item of request.input) {
    if (item.type === 'message') {
      if (options.groupAssistantToolCallsWithPreviousMessage && item.role === 'assistant') {
        const previous = messages[messages.length - 1];
        const text = textFromCanonicalContent(item.content);
        if (isAssistantMessageWithToolCalls(previous)) {
          const existingContent = typeof previous.content === 'string' ? previous.content : '';
          previous.content = existingContent.length > 0 && text.length > 0 ? `${existingContent}\n${text}` : existingContent || text;
          continue;
        }
      }
      messages.push({
        role: item.role,
        content: renderCanonicalContentToOpenAIChat(item.content),
        ...(options.preserveResponsesAgentSemantics && item.role === 'assistant' && item.phase
          ? { name: item.phase }
          : {}),
      });
      continue;
    }
    if (item.type === 'function_call') {
      const toolCall = {
        id: item.id,
        type: 'function',
        function: { name: item.name, arguments: stringifyToolArguments(item.arguments) },
      };
      // Parallel calls must share one assistant message: OpenAI requires the
      // tool results to immediately follow the message that requested them.
      const previous = messages[messages.length - 1];
      if (isAssistantMessage(previous)
        && (options.groupAssistantToolCallsWithPreviousMessage || Array.isArray(previous.tool_calls))) {
        const toolCalls = Array.isArray(previous.tool_calls) ? previous.tool_calls : [];
        previous.tool_calls = [...toolCalls, toolCall];
        continue;
      }
      messages.push({
        role: 'assistant',
        content: options.toolCallContent !== undefined ? options.toolCallContent : '',
        tool_calls: [toolCall],
      });
      continue;
    }
    messages.push({ role: 'tool', tool_call_id: item.callId, content: item.output });
  }

  const body: Record<string, unknown> = {
    ...(request.model ? { model: request.model } : {}),
    messages,
    stream: request.stream,
    ...(request.stream ? { stream_options: { include_usage: true } } : {}),
  };
  if (typeof request.maxOutputTokens === 'number') body.max_tokens = request.maxOutputTokens;
  if (typeof request.temperature === 'number') body.temperature = request.temperature;
  if (typeof request.topP === 'number') body.top_p = request.topP;
  if (request.stop !== undefined) body.stop = request.stop;
  const tools = renderCanonicalToolsToOpenAIChat(
    options.preserveResponsesAgentSemantics && request.tools?.length
      ? [...request.tools, { name: RESPONSES_FINAL_ANSWER_TOOL, parameters: { type: 'object', properties: {} } }]
      : request.tools,
  );
  const toolChoice = renderCanonicalToolChoiceToOpenAIChat(request.toolChoice);
  assignToolsAndToolChoice(body, tools, toolChoice);
  if (request.metadata) body.metadata = request.metadata;
  if (request.user) body.user = request.user;
  // Routes the request to the cache that holds this conversation's prefix.
  // Anthropic clients have no such field, so their per-session `user_id`
  // stands in for it (see normalizeAnthropicMessagesRequestBody).
  if (request.promptCacheKey) body.prompt_cache_key = request.promptCacheKey;
  return body;
}

export function renderCanonicalRequestToOpenAIResponsesBody(
  request: CanonicalLlmRequest,
  options: { includeMetadata?: boolean; includeUser?: boolean } = {},
): Record<string, unknown> {
  const input: unknown[] = [];

  for (const item of request.input) {
    if (item.type === 'message') {
      input.push({
        type: 'message',
        role: item.role,
        content: renderCanonicalContentToOpenAIResponses(item.content, item.role),
        ...(item.role === 'assistant' && item.phase ? { phase: item.phase } : {}),
      });
      continue;
    }
    if (item.type === 'function_call') {
      const id = responseFunctionCallId(item.id);
      input.push({
        type: 'function_call',
        id,
        call_id: id,
        name: item.name,
        arguments: stringifyToolArguments(item.arguments),
      });
      continue;
    }
    input.push({
      type: 'function_call_output',
      call_id: responseFunctionCallId(item.callId),
      output: item.output,
    });
  }

  const body: Record<string, unknown> = {
    ...(request.model ? { model: request.model } : {}),
    input,
    ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
    stream: request.stream,
  };
  if (typeof request.maxOutputTokens === 'number') body.max_output_tokens = request.maxOutputTokens;
  if (typeof request.temperature === 'number') body.temperature = request.temperature;
  if (typeof request.topP === 'number') body.top_p = request.topP;
  if (request.stop !== undefined) body.stop = request.stop;
  const tools = renderCanonicalToolsToOpenAIResponses(request.tools);
  const toolChoice = renderCanonicalToolChoiceToOpenAIResponses(request.toolChoice);
  assignToolsAndToolChoice(body, tools, toolChoice);
  if (options.includeMetadata !== false && request.metadata) body.metadata = request.metadata;
  if (options.includeUser !== false && request.user) body.user = request.user;
  if (request.promptCacheKey) body.prompt_cache_key = request.promptCacheKey;
  return body;
}

const EPHEMERAL_CACHE_CONTROL = { type: 'ephemeral' } as const;

/**
 * Below Anthropic's minimum cacheable prompt a breakpoint buys nothing, and a
 * cache write costs more than a plain read — so a synthesized breakpoint is
 * only worth placing on a prompt that is plausibly over it. Measured in
 * characters (~4 per token) against the 1024-token floor, with headroom.
 */
const MIN_SYNTHESIZED_CACHE_CHARS = 6_000;

/**
 * Breakpoints to render for an Anthropic seller. A request that carried its
 * own is reproduced verbatim — the client knows its prompt best. One that
 * carried none (every OpenAI-protocol client, which never declares them) gets
 * the standard pair: after the tools + system preamble, and after the last
 * turn, so the next turn reads back everything before its own input.
 */
function resolveCacheBreakpoints(request: CanonicalLlmRequest): CanonicalCacheBreakpoints {
  const declared = request.cacheBreakpoints;
  if (declared && (declared.instructions || declared.tools || declared.inputIndices.length > 0)) {
    return declared;
  }

  const instructionsLength = request.instructions?.length ?? 0;
  const inputLength = request.input.reduce((total, item) => (
    total + (item.type === 'message' ? textFromCanonicalContent(item.content).length : item.type === 'function_call_output' ? item.output.length : 0)
  ), 0);
  if (instructionsLength + inputLength < MIN_SYNTHESIZED_CACHE_CHARS) {
    return { instructions: false, tools: false, inputIndices: [] };
  }

  return {
    // Tools sit before the system prompt in Anthropic's prefix order, so one
    // marker after the system prompt already covers both.
    instructions: instructionsLength > 0,
    tools: instructionsLength === 0 && (request.tools?.length ?? 0) > 0,
    inputIndices: request.input.length > 0 ? [request.input.length - 1] : [],
  };
}

export function renderCanonicalRequestToAnthropicMessagesBody(request: CanonicalLlmRequest): Record<string, unknown> {
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = [];
  const breakpoints = resolveCacheBreakpoints(request);

  const appendBlock = (role: 'user' | 'assistant', block: Record<string, unknown>): void => {
    const previous = messages[messages.length - 1];
    if (previous?.role === role) {
      previous.content.push(block);
      return;
    }
    messages.push({ role, content: [block] });
  };

  const markLastBlock = (): void => {
    const lastMessage = messages[messages.length - 1];
    const lastBlock = lastMessage?.content[lastMessage.content.length - 1];
    if (lastBlock && typeof lastBlock === 'object') {
      (lastBlock as Record<string, unknown>).cache_control = EPHEMERAL_CACHE_CONTROL;
    }
  };

  for (const [index, item] of request.input.entries()) {
    if (item.type === 'message') {
      for (const part of renderCanonicalContentToAnthropic(item.content)) appendBlock(item.role, part);
    } else if (item.type === 'function_call') {
      appendBlock('assistant', {
        type: 'tool_use',
        id: item.id,
        name: item.name,
        input: parseToolArguments(item.arguments),
      });
    } else {
      appendBlock('user', {
        type: 'tool_result',
        tool_use_id: item.callId,
        content: item.output,
      });
    }
    if (breakpoints.inputIndices.includes(index)) markLastBlock();
  }

  const body: Record<string, unknown> = {
    ...(request.model ? { model: request.model } : {}),
    messages,
    stream: request.stream,
  };
  if (request.instructions !== undefined) {
    body.system = breakpoints.instructions
      ? [{ type: 'text', text: request.instructions, cache_control: EPHEMERAL_CACHE_CONTROL }]
      : request.instructions;
  }
  body.max_tokens = typeof request.maxOutputTokens === 'number'
    ? request.maxOutputTokens
    : DEFAULT_ANTHROPIC_MAX_TOKENS;
  if (typeof request.temperature === 'number') body.temperature = request.temperature;
  if (typeof request.topP === 'number') body.top_p = request.topP;
  if (request.stop !== undefined) body.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop];
  const tools = renderCanonicalToolsToAnthropic(request.tools);
  if (tools) {
    if (breakpoints.tools) {
      const lastTool = tools[tools.length - 1];
      if (lastTool) lastTool.cache_control = EPHEMERAL_CACHE_CONTROL;
    }
  }
  const toolChoice = renderCanonicalToolChoiceToAnthropic(request.toolChoice);
  assignToolsAndToolChoice(body, tools, toolChoice);
  if (request.metadata || request.user) {
    body.metadata = {
      ...(request.metadata ?? {}),
      ...(request.user ? { user_id: request.user } : {}),
    };
  }
  return body;
}

export function normalizeAnthropicMessagesRequestBody(body: Record<string, unknown>): CanonicalLlmRequest {
  const request: CanonicalLlmRequest = {
    model: modelFromBody(body),
    stream: body.stream === true,
    input: [],
  };

  const breakpoints: CanonicalCacheBreakpoints = { instructions: false, tools: false, inputIndices: [] };

  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const rawMessage of messages) {
    if (!rawMessage || typeof rawMessage !== 'object') continue;
    const message = rawMessage as Record<string, unknown>;
    const role = message.role === 'assistant' ? 'assistant' : 'user';

    if (Array.isArray(message.content)) {
      const cached = appendAnthropicContentBlocks(request.input, role, message.content);
      // Blocks coalesce into items, so the marker lands on the item the
      // message ends with — the position a client's breakpoint means.
      if (cached && request.input.length > 0) breakpoints.inputIndices.push(request.input.length - 1);
      continue;
    }

    const text = toStringContent(message.content);
    if (text.length > 0) {
      request.input.push({ type: 'message', role, content: [{ type: 'text', text }] });
    }
  }

  const instructions = body.system !== undefined ? toStringContent(body.system) : '';
  if (instructions.length > 0) request.instructions = instructions;
  breakpoints.instructions = hasAnthropicCacheControl(body.system);
  breakpoints.tools = hasAnthropicCacheControl(body.tools);
  if (breakpoints.instructions || breakpoints.tools || breakpoints.inputIndices.length > 0) {
    request.cacheBreakpoints = breakpoints;
  }
  if (typeof body.max_tokens === 'number') request.maxOutputTokens = body.max_tokens;
  if (typeof body.temperature === 'number') request.temperature = body.temperature;
  if (typeof body.top_p === 'number') request.topP = body.top_p;
  if (Array.isArray(body.stop_sequences)) request.stop = body.stop_sequences as string[];
  const tools = normalizeAnthropicTools(body.tools);
  if (tools) request.tools = tools;
  const toolChoice = normalizeAnthropicToolChoice(body.tool_choice);
  if (toolChoice !== undefined) request.toolChoice = toolChoice;
  if (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
    const metadata = body.metadata as Record<string, unknown>;
    request.metadata = metadata;
    if (typeof metadata.user_id === 'string') request.user = metadata.user_id;
  }
  if (request.user === undefined && typeof body.user === 'string') request.user = body.user;
  if (request.user !== undefined) request.promptCacheKey = request.user;
  return request;
}

export function normalizeOpenAIChatRequestBody(body: Record<string, unknown>): CanonicalLlmRequest {
  const request: CanonicalLlmRequest = {
    model: typeof body.model === 'string' && body.model.trim().length > 0 ? body.model.trim() : null,
    stream: body.stream === true,
    input: [],
  };

  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const msg = raw as Record<string, unknown>;
    const role = typeof msg.role === 'string' ? msg.role : '';

    if (role === 'system') {
      const text = textFromContent(msg.content);
      if (text.length > 0) {
        request.instructions = request.instructions !== undefined ? `${request.instructions}\n\n${text}` : text;
      }
      continue;
    }

    if (role === 'tool') {
      const callId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
      request.input.push({
        type: 'function_call_output',
        callId,
        output: textFromContent(msg.content),
      });
      continue;
    }

    if (role === 'assistant' && Array.isArray(msg.tool_calls)) {
      const text = textFromContent(msg.content);
      if (text.length > 0) request.input.push({ type: 'message', role: 'assistant', content: [{ type: 'text', text }] });
      for (const [index, rawToolCall] of (msg.tool_calls as unknown[]).entries()) {
        if (!rawToolCall || typeof rawToolCall !== 'object') continue;
        const toolCall = rawToolCall as Record<string, unknown>;
        const fn = toolCall.function && typeof toolCall.function === 'object'
          ? toolCall.function as Record<string, unknown>
          : {};
        request.input.push({
          type: 'function_call',
          id: typeof toolCall.id === 'string' && toolCall.id.length > 0 ? toolCall.id : `call_${index + 1}`,
          name: typeof fn.name === 'string' ? fn.name : '',
          arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        });
      }
      continue;
    }

    if (role === 'user' || role === 'assistant') {
      request.input.push({ type: 'message', role, content: canonicalContentFromOpenAIChat(msg.content) });
    }
  }

  if (typeof body.max_tokens === 'number') request.maxOutputTokens = body.max_tokens;
  if (typeof body.temperature === 'number') request.temperature = body.temperature;
  if (typeof body.top_p === 'number') request.topP = body.top_p;
  if (typeof body.stop === 'string' || Array.isArray(body.stop)) request.stop = body.stop as string | string[];
  if (Array.isArray(body.tools)) request.tools = normalizeChatTools(body.tools);
  const toolChoice = normalizeChatToolChoice(body.tool_choice);
  if (toolChoice !== undefined) request.toolChoice = toolChoice;
  if (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
    request.metadata = body.metadata as Record<string, unknown>;
  }
  if (typeof body.user === 'string') request.user = body.user;
  if (typeof body.prompt_cache_key === 'string' && body.prompt_cache_key.length > 0) {
    request.promptCacheKey = body.prompt_cache_key;
  }
  return request;
}

export function normalizeOpenAIResponsesRequestBody(body: Record<string, unknown>): CanonicalLlmRequest {
  const request: CanonicalLlmRequest = {
    model: typeof body.model === 'string' && body.model.trim().length > 0 ? body.model.trim() : null,
    stream: body.stream === true,
    input: [],
  };
  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    request.instructions = body.instructions;
  }

  const input = body.input;
  const normalizedInput = Array.isArray(input)
    ? input.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const msg = item as Record<string, unknown>;
      if (msg.type !== 'message' || msg.role !== 'assistant' || !Array.isArray(msg.content)) return item;
      const text = msg.content.map((part) => {
        if (!part || typeof part !== 'object') return '';
        const value = (part as Record<string, unknown>).text;
        return typeof value === 'string' ? value : '';
      }).join('');
      if (!RESPONSES_FINAL_ANSWER_TOOL_RE.test(text)) return item;
      return {
        ...msg,
        content: [{
          type: 'output_text',
          text: text.replace(RESPONSES_FINAL_ANSWER_TOOL_RE, '').trim(),
          ...(Array.isArray(msg.annotations) ? { annotations: msg.annotations } : {}),
        }],
      };
    })
    : input;
  if (typeof input === 'string') {
    request.input.push({ type: 'message', role: 'user', content: [{ type: 'text', text: input }] });
  } else if (Array.isArray(normalizedInput)) {
    for (const item of normalizedInput) {
      if (!item || typeof item !== 'object') continue;
      const msg = item as Record<string, unknown>;
      const type = typeof msg.type === 'string' ? msg.type : '';

      if (type === 'function_call_output') {
        request.input.push({
          type: 'function_call_output',
          callId: typeof msg.call_id === 'string' ? msg.call_id : '',
          output: typeof msg.output === 'string' ? msg.output : '',
        });
        continue;
      }

      if (type === 'function_call') {
        request.input.push({
          type: 'function_call',
          id: typeof msg.call_id === 'string' && msg.call_id.length > 0
            ? msg.call_id : (typeof msg.id === 'string' ? msg.id : ''),
          name: typeof msg.name === 'string' ? msg.name : '',
          arguments: typeof msg.arguments === 'string' ? msg.arguments : JSON.stringify(msg.arguments ?? {}),
        });
        continue;
      }

      // Codex interleaves reasoning/local_shell_call items with messages. They
      // have no role, and turning them into empty messages would separate a
      // function_call from its output.
      if (type !== 'message' && typeof msg.role !== 'string') continue;

      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      const content = canonicalContentFromOpenAIResponses(msg.content);
      // Non-message items (reasoning, web_search_call, ...) carry no renderable
      // text — dropping them avoids injecting empty user messages mid-history.
      if (type !== 'message' && textFromCanonicalContent(content).length === 0) continue;
      const phase = role === 'assistant' ? normalizeResponseMessagePhase(msg.phase) : undefined;
      request.input.push({ type: 'message', role, content, ...(phase ? { phase } : {}) });
    }
  }

  if (typeof body.max_output_tokens === 'number') request.maxOutputTokens = body.max_output_tokens;
  if (typeof body.temperature === 'number') request.temperature = body.temperature;
  if (typeof body.top_p === 'number') request.topP = body.top_p;
  if (typeof body.stop === 'string' || Array.isArray(body.stop)) request.stop = body.stop as string | string[];
  if (Array.isArray(body.tools)) request.tools = normalizeResponsesTools(body.tools);
  const toolChoice = normalizeResponsesToolChoice(body.tool_choice);
  if (toolChoice !== undefined) request.toolChoice = toolChoice;
  if (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
    request.metadata = body.metadata as Record<string, unknown>;
  }
  if (typeof body.user === 'string') request.user = body.user;
  if (typeof body.prompt_cache_key === 'string' && body.prompt_cache_key.length > 0) {
    request.promptCacheKey = body.prompt_cache_key;
  }
  return request;
}

export function normalizeOpenAIChatResponseBody(
  body: Record<string, unknown>,
  fallbacks: { id: string; model: string },
): CanonicalLlmResponse {
  const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : fallbacks.id;
  const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : fallbacks.model;
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const firstChoice = choices[0] && typeof choices[0] === 'object'
    ? choices[0] as Record<string, unknown>
    : {};
  const message = firstChoice.message && typeof firstChoice.message === 'object'
    ? firstChoice.message as Record<string, unknown>
    : {};

  const text = toStringContent(message.content);
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const output: CanonicalOutputItem[] = [];
  if (text.length > 0) {
    output.push({ type: 'text', text, phase: toolCalls.length > 0 ? 'commentary' : undefined });
  }
  for (const [index, rawToolCall] of toolCalls.entries()) {
    if (!rawToolCall || typeof rawToolCall !== 'object') continue;
    const toolCall = rawToolCall as Record<string, unknown>;
    const fn = toolCall.function && typeof toolCall.function === 'object'
      ? toolCall.function as Record<string, unknown>
      : {};
    if (fn.name === RESPONSES_FINAL_ANSWER_TOOL) continue;
    output.push({
      type: 'function_call',
      id: typeof toolCall.id === 'string' && toolCall.id.length > 0 ? toolCall.id : `call_${index + 1}`,
      name: typeof fn.name === 'string' ? fn.name : '',
      arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
    });
  }

  const usage = extractUsage(body);
  const stopReason = typeof firstChoice.finish_reason === 'string' ? firstChoice.finish_reason : null;
  return {
    id,
    model,
    output,
    stopReason,
    endTurn: toolCalls.some((toolCall) => {
      const fn = toolCall.function && typeof toolCall.function === 'object'
        ? toolCall.function as Record<string, unknown>
        : {};
      return fn.name === RESPONSES_FINAL_ANSWER_TOOL;
    })
      ? true
      : false,
    usage,
  };
}

export function normalizeOpenAIResponsesResponseBody(
  body: Record<string, unknown>,
  fallbacks: { id: string; model: string },
): CanonicalLlmResponse {
  const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : fallbacks.id;
  const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : fallbacks.model;
  const output: CanonicalOutputItem[] = [];

  const items = Array.isArray(body.output) ? body.output : [];
  for (const itemRaw of items) {
    if (!itemRaw || typeof itemRaw !== 'object') continue;
    const item = itemRaw as Record<string, unknown>;
    if (item.type === 'message') {
      const text = textFromResponsesContent(item.content);
      const phase = normalizeResponseMessagePhase(item.phase);
      if (text.length > 0) output.push({ type: 'text', text, ...(phase ? { phase } : {}) });
      continue;
    }
    if (item.type === 'function_call') {
      const idValue = typeof item.call_id === 'string' && item.call_id.length > 0
        ? item.call_id
        : (typeof item.id === 'string' ? item.id : '');
      output.push({
        type: 'function_call',
        id: chatFunctionCallId(idValue),
        name: typeof item.name === 'string' ? item.name : '',
        arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
      });
    }
  }

  const usage = extractUsage(body);
  const stopReason = openAIResponsesStopReason(body, output);
  return { id, model, output, stopReason, usage };
}

function openAIResponsesStopReason(
  body: Record<string, unknown>,
  output: CanonicalOutputItem[],
): string | null {
  if (body.status === 'incomplete') {
    const details = body.incomplete_details && typeof body.incomplete_details === 'object'
      ? body.incomplete_details as Record<string, unknown>
      : {};
    if (details.reason === 'max_output_tokens') return 'length';
    if (details.reason === 'content_filter') return 'content_filter';
    return null;
  }

  return output.some((item) => item.type === 'function_call') ? 'tool_calls' : 'stop';
}

export function normalizeAnthropicMessagesResponseBody(
  body: Record<string, unknown>,
  fallbacks: { id: string; model: string },
): CanonicalLlmResponse {
  const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : fallbacks.id;
  const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : fallbacks.model;
  const output: CanonicalOutputItem[] = [];

  const content = Array.isArray(body.content) ? body.content : [];
  for (const blockRaw of content) {
    if (!blockRaw || typeof blockRaw !== 'object') continue;
    const block = blockRaw as Record<string, unknown>;
    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      if (text.length > 0) output.push({ type: 'text', text });
      continue;
    }
    if (block.type === 'tool_use') {
      output.push({
        type: 'function_call',
        id: typeof block.id === 'string' ? block.id : '',
        name: typeof block.name === 'string' ? block.name : '',
        arguments: block.input && typeof block.input === 'object' && !Array.isArray(block.input)
          ? block.input as Record<string, unknown>
          : {},
      });
    }
  }

  const usage = extractUsage(body);
  const stopReason = anthropicStopReasonToOpenAI(body.stop_reason);
  return { id, model, output, stopReason, usage };
}

export function renderCanonicalResponseToOpenAIChatBody(response: CanonicalLlmResponse): Record<string, unknown> {
  const text = response.output
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text)
    .join('');
  const toolCalls = response.output
    .filter((item): item is Extract<CanonicalOutputItem, { type: 'function_call' }> => item.type === 'function_call')
    .map((item) => ({
      id: chatFunctionCallId(item.id),
      type: 'function',
      function: { name: item.name, arguments: stringifyToolArguments(item.arguments) },
    }));

  return {
    id: response.id,
    object: 'chat.completion',
    model: response.model,
    created: Math.floor(Date.now() / 1000),
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text.length > 0 ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: response.stopReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    }],
    usage: openAIChatUsage(response.usage),
  };
}

export function renderCanonicalResponseToOpenAIResponsesBody(response: CanonicalLlmResponse): Record<string, unknown> {
  const output: unknown[] = [];
  const textItems = response.output
    .filter((item): item is Extract<CanonicalOutputItem, { type: 'text' }> => item.type === 'text');
  const text = textItems.map((item) => item.text).join('');
  const phase = textItems.find((item) => item.phase)?.phase;

  if (text.length > 0) {
    output.push({
      type: 'message',
      id: openAIResponsesMessageId(response.id),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
      ...(phase ? { phase } : {}),
    });
  }

  for (const item of response.output) {
    if (item.type !== 'function_call') continue;
    output.push({
      type: 'function_call',
      id: openAIResponsesFunctionCallId(item.id),
      call_id: item.id,
      name: item.name,
      arguments: stringifyToolArguments(item.arguments),
      status: 'completed',
    });
  }

  return {
    id: response.id,
    object: 'response',
    model: response.model,
    status: 'completed',
    created_at: Math.floor(Date.now() / 1000),
    output,
    output_text: text,
    ...(response.endTurn !== undefined ? { end_turn: response.endTurn } : {}),
    usage: openAIResponsesUsage(response.usage),
  };
}

export function renderCanonicalResponseToAnthropicMessagesBody(response: CanonicalLlmResponse): Record<string, unknown> {
  const content = response.output.map((item) => {
    if (item.type === 'text') return { type: 'text', text: item.text };
    return {
      type: 'tool_use',
      id: item.id,
      name: item.name || 'tool',
      input: parseToolArguments(item.arguments),
    };
  });

  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    model: response.model,
    content,
    stop_reason: mapFinishReasonToAnthropicStopReason(response.stopReason),
    stop_sequence: null,
    usage: anthropicUsage(response.usage),
  };
}

function openAIChatUsage(usage: TokenUsage): Record<string, unknown> {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    ...(usage.cachedInputTokens > 0
      ? { prompt_tokens_details: { cached_tokens: usage.cachedInputTokens } }
      : {}),
  };
}

function openAIResponsesUsage(usage: TokenUsage): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    ...(usage.cachedInputTokens > 0
      ? { input_tokens_details: { cached_tokens: usage.cachedInputTokens } }
      : {}),
  };
}

function anthropicUsage(usage: TokenUsage): Record<string, unknown> {
  return {
    input_tokens: usage.freshInputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.cachedInputTokens > 0 ? { cache_read_input_tokens: usage.cachedInputTokens } : {}),
  };
}

function stringifyToolArguments(args: Record<string, unknown> | string): string {
  return typeof args === 'string' ? args : JSON.stringify(args);
}

function parseToolArguments(args: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof args !== 'string') return args;
  const parsed = parseJsonSafe(args);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return { raw: args };
}

function modelFromBody(body: Record<string, unknown>): string | null {
  return typeof body.model === 'string' && body.model.trim().length > 0 ? body.model.trim() : null;
}

function normalizeResponseMessagePhase(value: unknown): CanonicalResponseMessagePhase | undefined {
  return value === 'commentary' || value === 'final_answer' ? value : undefined;
}

function appendResponsesChatCompatibilityInstructions(instructions: string | undefined): string {
  const compatibility = [
    'Chat Completions compatibility requirement:',
    '- Assistant messages named "commentary" are interim progress updates, not final answers.',
    '- If more work remains, do not end with commentary alone; include the next tool call in the same response.',
    '- Return text without a tool call only when it is the final answer to the user.',
  ].join('\n');
  return instructions ? `${instructions}\n\n${compatibility}` : compatibility;
}

function isAssistantMessage(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
    && (value as Record<string, unknown>).role === 'assistant';
}

function isAssistantMessageWithToolCalls(value: unknown): value is Record<string, unknown> {
  return isAssistantMessage(value) && Array.isArray(value.tool_calls);
}

function textFromCanonicalContent(content: CanonicalContentPart[]): string {
  return content
    .filter((part): part is Extract<CanonicalContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .filter((text) => text.length > 0)
    .join('\n');
}

function renderCanonicalContentToOpenAIChat(content: CanonicalContentPart[]): string | unknown[] {
  const hasImage = content.some((part) => part.type === 'image');
  if (!hasImage) return textFromCanonicalContent(content);
  const rendered: unknown[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text.length > 0) rendered.push({ type: 'text', text: part.text });
      continue;
    }
    const url = imageUrlFromCanonicalPart(part);
    if (url) rendered.push({ type: 'image_url', image_url: { url } });
  }
  return rendered;
}

function renderCanonicalContentToOpenAIResponses(content: CanonicalContentPart[], role: 'user' | 'assistant'): unknown[] {
  const textType = role === 'assistant' ? 'output_text' : 'input_text';
  const rendered: unknown[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text.length > 0) rendered.push({ type: textType, text: part.text });
      continue;
    }
    const url = imageUrlFromCanonicalPart(part);
    if (url) rendered.push({ type: 'input_image', image_url: url });
  }
  return rendered;
}

function renderCanonicalContentToAnthropic(content: CanonicalContentPart[]): Array<Record<string, unknown>> {
  const rendered: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text.length > 0) rendered.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.data && part.mediaType) {
      rendered.push({ type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } });
      continue;
    }
    if (part.url) rendered.push({ type: 'image', source: { type: 'url', url: part.url } });
  }
  return rendered;
}

function imageUrlFromCanonicalPart(part: Extract<CanonicalContentPart, { type: 'image' }>): string | undefined {
  if (part.url) return part.url;
  if (part.data && part.mediaType) return `data:${part.mediaType};base64,${part.data}`;
  return undefined;
}

function canonicalContentFromOpenAIChat(value: unknown): CanonicalContentPart[] {
  if (typeof value === 'string') return value.length > 0 ? [{ type: 'text', text: value }] : [];
  if (!Array.isArray(value)) return textFromContent(value).length > 0 ? [{ type: 'text', text: textFromContent(value) }] : [];
  return value.flatMap((part): CanonicalContentPart[] => {
    if (!part || typeof part !== 'object') return [];
    const block = part as Record<string, unknown>;
    if (typeof block.text === 'string') return [{ type: 'text', text: block.text }];
    if (block.type === 'image_url' && block.image_url && typeof block.image_url === 'object') {
      const url = (block.image_url as Record<string, unknown>).url;
      return typeof url === 'string' ? [canonicalImageFromUrl(url)] : [];
    }
    if (block.type === 'input_image' && typeof block.image_url === 'string') return [canonicalImageFromUrl(block.image_url)];
    return [];
  });
}

function canonicalContentFromOpenAIResponses(value: unknown): CanonicalContentPart[] {
  if (typeof value === 'string') return value.length > 0 ? [{ type: 'text', text: value }] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((part): CanonicalContentPart[] => {
    if (!part || typeof part !== 'object') return [];
    const block = part as Record<string, unknown>;
    if (typeof block.text === 'string') return [{ type: 'text', text: block.text }];
    if (block.type === 'input_image' && typeof block.image_url === 'string') return [canonicalImageFromUrl(block.image_url)];
    return [];
  });
}

function canonicalImageFromUrl(url: string): CanonicalContentPart {
  const data = url.match(/^data:([^;,]+);base64,(.*)$/);
  return data ? { type: 'image', mediaType: data[1], data: data[2] } : { type: 'image', url };
}

function canonicalImageFromAnthropicSource(source: unknown): CanonicalContentPart | undefined {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const src = source as Record<string, unknown>;
  if (src.type === 'base64' && typeof src.media_type === 'string' && typeof src.data === 'string') {
    return { type: 'image', mediaType: src.media_type, data: src.data };
  }
  if (src.type === 'url' && typeof src.url === 'string') return { type: 'image', url: src.url };
  return undefined;
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value
      .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === 'object')
      .map((part) => {
        if (typeof part.text === 'string') return part.text;
        if (typeof part.refusal === 'string') return part.refusal;
        if (part.type === 'tool_result') return textFromContent(part.content);
        return '';
      })
      .filter((text) => text.length > 0)
      .join('\n');
  }
  if (typeof value === 'object') {
    const part = value as Record<string, unknown>;
    if (typeof part.text === 'string') return part.text;
    if (typeof part.refusal === 'string') return part.refusal;
  }
  return String(value);
}

function textFromResponsesContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === 'object')
    .map((part) => typeof part.text === 'string' ? part.text : '')
    .filter((text) => text.length > 0)
    .join('\n');
}

/** True when any block in this value carries a `cache_control` marker. */
function hasAnthropicCacheControl(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((block) => (
    block !== null
    && typeof block === 'object'
    && (block as Record<string, unknown>).cache_control !== undefined
  ));
}

/** Returns whether the message declared a cache breakpoint on any of its blocks. */
function appendAnthropicContentBlocks(
  input: CanonicalInputItem[],
  role: 'user' | 'assistant',
  blocks: unknown[],
): boolean {
  const startLength = input.length;
  let contentParts: CanonicalContentPart[] = [];
  const flushMessage = (): void => {
    if (contentParts.length === 0) return;
    input.push({ type: 'message', role, content: contentParts });
    contentParts = [];
  };

  for (const blockRaw of blocks) {
    if (!blockRaw || typeof blockRaw !== 'object') continue;
    const block = blockRaw as Record<string, unknown>;

    if (role === 'assistant' && block.type === 'tool_use') {
      flushMessage();
      input.push({
        type: 'function_call',
        id: typeof block.id === 'string' && block.id.length > 0 ? block.id : `call_${input.length + 1}`,
        name: typeof block.name === 'string' && block.name.length > 0 ? block.name : 'tool',
        arguments: block.input && typeof block.input === 'object' && !Array.isArray(block.input)
          ? block.input as Record<string, unknown>
          : {},
      });
      continue;
    }

    if (role === 'user' && block.type === 'tool_result') {
      flushMessage();
      const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      if (callId.length > 0) {
        input.push({ type: 'function_call_output', callId, output: toStringContent(block.content) });
      }
      continue;
    }

    if (role === 'user' && block.type === 'image') {
      const image = canonicalImageFromAnthropicSource(block.source);
      if (image) contentParts.push(image);
      continue;
    }

    const text = toStringContent(block);
    if (text.length > 0) contentParts.push({ type: 'text', text });
  }

  flushMessage();
  return input.length > startLength && hasAnthropicCacheControl(blocks);
}

function normalizeAnthropicTools(toolsRaw: unknown): CanonicalFunctionTool[] | undefined {
  if (!Array.isArray(toolsRaw) || toolsRaw.length === 0) return undefined;
  const out: CanonicalFunctionTool[] = [];
  for (const toolRaw of toolsRaw) {
    if (!toolRaw || typeof toolRaw !== 'object') continue;
    const tool = toolRaw as Record<string, unknown>;
    if (typeof tool.name !== 'string' || tool.name.length === 0) continue;
    const entry: CanonicalFunctionTool = {
      name: tool.name,
      parameters: toolParameters(tool.input_schema),
    };
    if (typeof tool.description === 'string' && tool.description.length > 0) entry.description = tool.description;
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeChatTools(tools: unknown[]): CanonicalFunctionTool[] | undefined {
  const out: CanonicalFunctionTool[] = [];
  for (const raw of tools) {
    if (!raw || typeof raw !== 'object') continue;
    const tool = raw as Record<string, unknown>;
    if (tool.type !== 'function' || !tool.function || typeof tool.function !== 'object') continue;
    const fn = tool.function as Record<string, unknown>;
    if (typeof fn.name !== 'string' || fn.name.length === 0) continue;
    const entry: CanonicalFunctionTool = { name: fn.name, parameters: toolParameters(fn.parameters) };
    if (typeof fn.description === 'string' && fn.description.length > 0) entry.description = fn.description;
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeResponsesTools(tools: unknown[]): CanonicalFunctionTool[] | undefined {
  const out: CanonicalFunctionTool[] = [];
  for (const raw of tools) {
    if (!raw || typeof raw !== 'object') continue;
    const tool = raw as Record<string, unknown>;
    if (tool.type !== 'function' || typeof tool.name !== 'string' || tool.name.length === 0) continue;
    const entry: CanonicalFunctionTool = { name: tool.name, parameters: toolParameters(tool.parameters) };
    if (typeof tool.description === 'string' && tool.description.length > 0) entry.description = tool.description;
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

function renderCanonicalToolsToAnthropic(
  tools: CanonicalFunctionTool[] | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.parameters,
  }));
}

function renderCanonicalToolsToOpenAIChat(tools: CanonicalFunctionTool[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters,
    },
  }));
}

function renderCanonicalToolsToOpenAIResponses(tools: CanonicalFunctionTool[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters,
  }));
}

function normalizeAnthropicToolChoice(toolChoice: unknown): CanonicalToolChoice | undefined {
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') return toolChoice;
    return undefined;
  }
  if (!toolChoice || typeof toolChoice !== 'object' || Array.isArray(toolChoice)) return undefined;
  const choice = toolChoice as Record<string, unknown>;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool' && typeof choice.name === 'string' && choice.name.length > 0) {
    return { type: 'function', name: choice.name };
  }
  return undefined;
}

function normalizeChatToolChoice(toolChoice: unknown): CanonicalToolChoice | undefined {
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') return toolChoice;
    return undefined;
  }
  if (!toolChoice || typeof toolChoice !== 'object' || Array.isArray(toolChoice)) return undefined;
  const choice = toolChoice as Record<string, unknown>;
  if (choice.type === 'function' && choice.function && typeof choice.function === 'object') {
    const fn = choice.function as Record<string, unknown>;
    if (typeof fn.name === 'string') return { type: 'function', name: fn.name };
  }
  return undefined;
}

function normalizeResponsesToolChoice(toolChoice: unknown): CanonicalToolChoice | undefined {
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') return toolChoice;
    return undefined;
  }
  if (!toolChoice || typeof toolChoice !== 'object' || Array.isArray(toolChoice)) return undefined;
  const choice = toolChoice as Record<string, unknown>;
  if (choice.type === 'function' && typeof choice.name === 'string') {
    return { type: 'function', name: choice.name };
  }
  return undefined;
}

function renderCanonicalToolChoiceToAnthropic(toolChoice: CanonicalToolChoice | undefined): unknown {
  if (toolChoice === 'required') return { type: 'any' };
  if (toolChoice === 'auto' || toolChoice === 'none') return { type: toolChoice };
  if (toolChoice?.type === 'function') return { type: 'tool', name: toolChoice.name };
  return undefined;
}

function renderCanonicalToolChoiceToOpenAIChat(toolChoice: CanonicalToolChoice | undefined): unknown {
  if (typeof toolChoice === 'string') return toolChoice;
  if (toolChoice?.type === 'function') {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  return undefined;
}

function anthropicStopReasonToOpenAI(stopReason: unknown): string | null {
  if (typeof stopReason !== 'string' || stopReason.length === 0) return null;
  if (stopReason === 'end_turn') return 'stop';
  if (stopReason === 'max_tokens') return 'length';
  if (stopReason === 'tool_use') return 'tool_calls';
  return stopReason;
}

function renderCanonicalToolChoiceToOpenAIResponses(toolChoice: CanonicalToolChoice | undefined): unknown {
  if (typeof toolChoice === 'string') return toolChoice;
  if (toolChoice?.type === 'function') {
    return { type: 'function', name: toolChoice.name };
  }
  return undefined;
}
