import { describe, expect, it } from 'vitest';
import { renderRequestBodyAsOpenAIChat, transformRequest, type ServiceApiProtocol } from '../src/index.js';

const MESSAGES = 'anthropic-messages';
const CHAT = 'openai-chat-completions';
const RESPONSES = 'openai-responses';

const PATHS: Record<string, string> = {
  [MESSAGES]: '/v1/messages',
  [CHAT]: '/v1/chat/completions',
  [RESPONSES]: '/v1/responses',
};

/** The request a seller that speaks `to` receives for a client request in `from` carrying `fields`. */
function translated(
  from: ServiceApiProtocol,
  to: ServiceApiProtocol,
  fields: Record<string, unknown>,
  stream = false,
): Record<string, unknown> {
  const prompt = from === RESPONSES
    ? { input: 'Why is the sky blue?' }
    : { messages: [{ role: 'user', content: 'Why is the sky blue?' }] };
  const result = transformRequest({
    requestId: 'req-reasoning-effort',
    method: 'POST',
    path: PATHS[from]!,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ model: 'example-model', ...prompt, stream, ...fields })),
  }, { from, to });
  expect(result).not.toBeNull();
  return JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;
}

/** The members of a translated request that set how much the model reasons. */
function reasoningFields(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    ['reasoning_effort', 'reasoning', 'thinking', 'output_config'].filter((key) => key in body).map((key) => [key, body[key]]),
  );
}

const OPENAI_CLIENTS = [
  { from: CHAT, effort: (level: string) => ({ reasoning_effort: level }) },
  { from: RESPONSES, effort: (level: string) => ({ reasoning: { effort: level } }) },
] as const;

describe('reasoning effort from an OpenAI client to an Anthropic Messages seller', () => {
  for (const { from, effort } of OPENAI_CLIENTS) {
    it.each(['low', 'medium', 'high', 'xhigh', 'max'])(`preserves ${from} effort %s as output_config.effort`, (level) => {
      for (const stream of [false, true]) {
        expect(reasoningFields(translated(from, MESSAGES, effort(level), stream))).toEqual({ output_config: { effort: level } });
      }
    });

    it(`preserves ${from} effort none as thinking disabled`, () => {
      for (const stream of [false, true]) {
        expect(reasoningFields(translated(from, MESSAGES, effort('none'), stream))).toEqual({ thinking: { type: 'disabled' } });
      }
    });

    it(`sends ${from} effort minimal, for which Messages has no word, as low, the lowest effort Messages has`, () => {
      for (const stream of [false, true]) {
        expect(reasoningFields(translated(from, MESSAGES, effort('minimal'), stream))).toEqual({ output_config: { effort: 'low' } });
      }
    });

    it.each(['ultra', 'adaptive'])(`copies ${from} effort %s, a word no list here knows, as it does between the OpenAI protocols`, (level) => {
      expect(reasoningFields(translated(from, MESSAGES, effort(level)))).toEqual({ output_config: { effort: level } });
    });

    it(`sends no reasoning field when the ${from} request names no effort`, () => {
      expect(reasoningFields(translated(from, MESSAGES, {}))).toEqual({});
    });
  }

  it('carries only the effort of a Responses reasoning object, not its summary setting', () => {
    expect(reasoningFields(translated(RESPONSES, MESSAGES, { reasoning: { effort: 'high', summary: 'auto' } })))
      .toEqual({ output_config: { effort: 'high' } });
    expect(reasoningFields(translated(RESPONSES, MESSAGES, { reasoning: { summary: 'auto' } }))).toEqual({});
  });
});

describe('reasoning effort from an Anthropic Messages client to an OpenAI seller', () => {
  const OPENAI_SELLERS = [
    { to: CHAT, effort: (level: string) => ({ reasoning_effort: level }) },
    { to: RESPONSES, effort: (level: string) => ({ reasoning: { effort: level } }) },
  ] as const;

  for (const { to, effort } of OPENAI_SELLERS) {
    it.each(['low', 'medium', 'high', 'xhigh', 'max'])(`preserves output_config.effort %s for a ${to} seller`, (level) => {
      for (const stream of [false, true]) {
        expect(reasoningFields(translated(MESSAGES, to, { max_tokens: 4096, output_config: { effort: level } }, stream)))
          .toEqual(effort(level));
      }
    });

    it(`preserves the effort beside adaptive thinking for a ${to} seller`, () => {
      const fields = { max_tokens: 4096, thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'xhigh' } };
      expect(reasoningFields(translated(MESSAGES, to, fields))).toEqual(effort('xhigh'));
    });

    it(`names no level for a ${to} seller when thinking is disabled, which may only restate the Messages default`, () => {
      for (const stream of [false, true]) {
        expect(reasoningFields(translated(MESSAGES, to, { max_tokens: 4096, thinking: { type: 'disabled' } }, stream))).toEqual({});
      }
    });

    it(`sends a ${to} seller no effort set beside disabled thinking, which would switch reasoning on`, () => {
      const fields = { max_tokens: 4096, thinking: { type: 'disabled' }, output_config: { effort: 'high' } };
      expect(reasoningFields(translated(MESSAGES, to, fields))).toEqual({});
    });

    it.each(['ultra', 'adaptive'])(`copies %s, a word no list here knows, for a ${to} seller`, (level) => {
      expect(reasoningFields(translated(MESSAGES, to, { max_tokens: 4096, output_config: { effort: level } }))).toEqual(effort(level));
    });

    it(`names the default effort medium for switched-on thinking, never one derived from the budget, for a ${to} seller`, () => {
      for (const budget_tokens of [500, 1024, 2000, 8000, 16000, 32000, 64000]) {
        for (const stream of [false, true]) {
          const fields = { max_tokens: 4096, thinking: { type: 'enabled', budget_tokens } };
          expect(reasoningFields(translated(MESSAGES, to, fields, stream))).toEqual(effort('medium'));
        }
      }
      for (const stream of [false, true]) {
        expect(reasoningFields(translated(MESSAGES, to, { max_tokens: 4096, thinking: { type: 'adaptive' } }, stream))).toEqual(effort('medium'));
      }
      expect(reasoningFields(translated(MESSAGES, to, { max_tokens: 4096 }))).toEqual({});
    });

    it(`lets an explicit effort beat the medium default of enabled or adaptive thinking for a ${to} seller`, () => {
      for (const level of ['low', 'high']) {
        const enabled = { max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 2000 }, output_config: { effort: level } };
        const adaptive = { max_tokens: 4096, thinking: { type: 'adaptive' }, output_config: { effort: level } };
        expect(reasoningFields(translated(MESSAGES, to, enabled))).toEqual(effort(level));
        expect(reasoningFields(translated(MESSAGES, to, adaptive))).toEqual(effort(level));
      }
    });

    it(`ignores an output_config with no usable effort for a ${to} seller`, () => {
      expect(reasoningFields(translated(MESSAGES, to, { max_tokens: 4096, output_config: { format: { type: 'json_schema' } } }))).toEqual({});
      expect(reasoningFields(translated(MESSAGES, to, { max_tokens: 4096, output_config: { effort: '' } }))).toEqual({});
      expect(reasoningFields(translated(MESSAGES, to, { max_tokens: 4096, output_config: { effort: 3 } }))).toEqual({});
    });
  }
});

describe('reasoning effort in the Chat Completions body a routing service is asked with', () => {
  const prompt = { messages: [{ role: 'user', content: 'Why is the sky blue?' }], max_tokens: 4096 };

  it('names the effort of a Messages request, as it already does for a Chat Completions or Responses one', () => {
    expect(reasoningFields(renderRequestBodyAsOpenAIChat(MESSAGES, { ...prompt, output_config: { effort: 'high' } })!))
      .toEqual({ reasoning_effort: 'high' });
    expect(reasoningFields(renderRequestBodyAsOpenAIChat(RESPONSES, { input: 'Why is the sky blue?', reasoning: { effort: 'high' } })!))
      .toEqual({ reasoning_effort: 'high' });
    expect(reasoningFields(renderRequestBodyAsOpenAIChat(CHAT, { ...prompt, reasoning_effort: 'high' })!))
      .toEqual({ reasoning_effort: 'high' });
  });

  it('names no effort for a Messages request with thinking disabled or with no effort', () => {
    expect(reasoningFields(renderRequestBodyAsOpenAIChat(MESSAGES, { ...prompt, thinking: { type: 'disabled' } })!)).toEqual({});
    expect(reasoningFields(renderRequestBodyAsOpenAIChat(MESSAGES, prompt)!)).toEqual({});
  });

  it('names the default effort medium for a Messages request with thinking switched on', () => {
    expect(reasoningFields(renderRequestBodyAsOpenAIChat(MESSAGES, { ...prompt, thinking: { type: 'adaptive' } })!))
      .toEqual({ reasoning_effort: 'medium' });
    expect(reasoningFields(renderRequestBodyAsOpenAIChat(MESSAGES, { ...prompt, thinking: { type: 'enabled', budget_tokens: 2000 } })!))
      .toEqual({ reasoning_effort: 'medium' });
  });
});

describe('the one effort word that is replaced', () => {
  it('is minimal towards Messages only: a Messages low stays low for an OpenAI seller', () => {
    expect(reasoningFields(translated(MESSAGES, CHAT, { max_tokens: 4096, output_config: { effort: 'low' } }))).toEqual({ reasoning_effort: 'low' });
    expect(reasoningFields(translated(MESSAGES, RESPONSES, { max_tokens: 4096, output_config: { effort: 'low' } }))).toEqual({ reasoning: { effort: 'low' } });
  });

  it('is not replaced in the Chat Completions body a routing service is asked with', () => {
    expect(reasoningFields(renderRequestBodyAsOpenAIChat(RESPONSES, { input: 'Why is the sky blue?', reasoning: { effort: 'minimal' } })!))
      .toEqual({ reasoning_effort: 'minimal' });
  });
});

describe('reasoning effort between the two OpenAI protocols', () => {
  it.each(['none', 'minimal', 'low', 'xhigh'])('still carries %s unchanged, as before', (level) => {
    expect(reasoningFields(translated(CHAT, RESPONSES, { reasoning_effort: level }))).toEqual({ reasoning: { effort: level } });
    expect(reasoningFields(translated(RESPONSES, CHAT, { reasoning: { effort: level } }))).toEqual({ reasoning_effort: level });
  });
});
