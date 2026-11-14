import { describe, expect, it } from 'vitest';
import { parseModels } from './index.js';
import { saysReady } from './pool.js';
import { splitModelPin } from './model-pins.js';
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

  it('takes a files digest on a pool pin, but not on a worker\'s', () => {
    const pin = `org/model@abc123#${'ab'.repeat(32)}`;
    expect(parseModels(`qwen=${pin}`, ['qwen'])).toEqual(new Map([['qwen', pin]]));
    expect(splitModelPin(pin)).toEqual({ model: 'org/model@abc123', sha256: 'ab'.repeat(32) });
    expect(splitModelPin('org/model@abc123')).toEqual({ model: 'org/model@abc123' });
    expect(() => parseModels(`qwen=org/model@abc123#${'AB'.repeat(32)}`, ['qwen'])).toThrow(/not service=repo@revision or service=repo@revision#sha256/);
    expect(() => parseModels('qwen=org/model@abc123#abc', ['qwen'])).toThrow(/not service=repo@revision/);
    expect(() => parseWorkerModels(`qwen=${pin}`, ['qwen'])).toThrow(/not service=repo@revision/);
  });

  it('parses a worker\'s --models for services it serves', () => {
    expect(parseWorkerModels('qwen=org/model@abc123', ['qwen'])).toEqual({ qwen: 'org/model@abc123' });
    expect(parseWorkerModels(undefined, ['qwen'])).toEqual({});
    expect(() => parseWorkerModels('qwen=org/model', ['qwen'])).toThrow(/not service=repo@revision/);
    expect(() => parseWorkerModels('llama=org/l@1', ['qwen'])).toThrow(/not one of --services/);
    expect(() => parseWorkerModels('qwen=a/b@1,qwen=a/b@2', ['qwen'])).toThrow(/--models: qwen is listed twice/);
  });
});
