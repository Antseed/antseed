import { describe, expect, it } from 'vitest';
import { parseModels } from './index.js';
import { saysReady } from './pool.js';
import { parseWorkerModels } from './worker.js';

const reply = (content: unknown) => Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));

describe('join check reply', () => {
  it('accepts "ready" give or take case, quotes, punctuation and a reasoning block', () => {
    for (const content of ['ready', 'Ready.', '  READY!\n', '"ready"', '**Ready**', '<think>short</think>\nready']) {
      expect(saysReady(reply(content))).toBe(true);
    }
  });

  it('refuses any other answer, an empty one, and malformed bodies', () => {
    for (const content of ['not ready', 'Ready to help!', 'hello', '', null, ['ready']]) {
      expect(saysReady(reply(content))).toBe(false);
    }
    expect(saysReady(Buffer.from('{"choices":[]}'))).toBe(false);
    expect(saysReady(Buffer.from('not json'))).toBe(false);
  });
});

describe('model pins', () => {
  it('parses COLONY_POOL_MODELS for services the pool sells, with a pinned revision', () => {
    expect(parseModels('qwen=org/model@abc123, llama=org/l@v1', ['qwen', 'llama'])).toEqual(new Map([['qwen', 'org/model@abc123'], ['llama', 'org/l@v1']]));
    expect(parseModels(undefined, ['qwen']).size).toBe(0);
    expect(() => parseModels('qwen=org/model', ['qwen'])).toThrow(/not service=repo@revision/);
    expect(() => parseModels('qwen=org/model@', ['qwen'])).toThrow(/not service=repo@revision/);
    expect(() => parseModels('other=org/m@1', ['qwen'])).toThrow(/not one of ANTSEED_ALLOWED_SERVICES/);
    expect(() => parseModels('qwen=a/b@1,qwen=a/b@2', ['qwen'])).toThrow(/listed twice/);
  });

  it('parses a worker\'s --models for services it serves', () => {
    expect(parseWorkerModels('qwen=org/model@abc123', ['qwen'])).toEqual({ qwen: 'org/model@abc123' });
    expect(parseWorkerModels(undefined, ['qwen'])).toEqual({});
    expect(() => parseWorkerModels('qwen=org/model', ['qwen'])).toThrow(/not service=repo@revision/);
    expect(() => parseWorkerModels('llama=org/l@1', ['qwen'])).toThrow(/not one of --services/);
  });
});
