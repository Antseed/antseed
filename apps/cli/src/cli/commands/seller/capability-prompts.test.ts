import assert from 'node:assert/strict';
import test from 'node:test';
import { promptServiceCapabilities, type Prompt } from './capability-prompts.js';

function scriptedPrompt(answers: string[]): Prompt & { remaining(): number } {
  const queue = [...answers];
  return {
    question: async () => {
      const answer = queue.shift();
      if (answer === undefined) throw new Error('Prompt asked more questions than scripted');
      return answer;
    },
    remaining: () => queue.length,
  };
}

test('builds a full capabilities object from per-field answers', async () => {
  const rl = scriptedPrompt([
    'y',
    '128000',       // context window
    '32768',        // max output tokens
    'text, image',  // inputs
    'image',        // outputs
    'y',            // reasoning
    'n',            // tool use
    '',             // structured output (skip)
    'background, output_format, seed',
  ]);
  const caps = await promptServiceCapabilities(rl);
  assert.deepEqual(caps, {
    contextWindow: 128000,
    maxOutputTokens: 32768,
    inputs: ['text', 'image'],
    outputs: ['image'],
    reasoning: true,
    toolUse: false,
    supportedParameters: ['background', 'output_format', 'seed'],
  });
  assert.equal(rl.remaining(), 0);
});

test('declining the opening question asks nothing else', async () => {
  const rl = scriptedPrompt(['']);
  assert.equal(await promptServiceCapabilities(rl), undefined);
  assert.equal(rl.remaining(), 0);
});

test('skipping every field yields no capabilities entry', async () => {
  const rl = scriptedPrompt(['y', '', '', '', '', '', '', '', '']);
  assert.equal(await promptServiceCapabilities(rl), undefined);
});

test('re-asks a field until the answer validates', async () => {
  const rl = scriptedPrompt([
    'y',
    'lots',          // not a number
    '-5',            // not positive
    '99999999999',   // above MAX_CAPABILITY_TOKEN_COUNT — must match the JSON-paste path
    '200000',        // valid
    '', '', '', '', '', '', '',
  ]);
  const caps = await promptServiceCapabilities(rl);
  assert.deepEqual(caps, { contextWindow: 200000 });
  assert.equal(rl.remaining(), 0);
});

test('rejects unknown modalities and bad parameter names before accepting valid ones', async () => {
  const rl = scriptedPrompt([
    'y',
    '', '',
    'text, hologram', // invalid input modality
    'text',
    '',               // outputs skipped
    '', '', '',
    'output-format',  // hyphen is not snake_case
    'seed',
  ]);
  const caps = await promptServiceCapabilities(rl);
  assert.deepEqual(caps, { inputs: ['text'], supportedParameters: ['seed'] });
});

test('image services get the short protocol-specific question set', async () => {
  const rl = scriptedPrompt([
    'y',
    'text,image',                      // inputs (upstream supports edits)
    'background, output_format, size', // supported parameters
  ]);
  const caps = await promptServiceCapabilities(rl, 'image');
  assert.deepEqual(caps, {
    inputs: ['text', 'image'],
    supportedParameters: ['background', 'output_format', 'size'],
  });
  assert.equal(rl.remaining(), 0);
});

test('pasting JSON at the opening question keeps the old path working', async () => {
  const rl = scriptedPrompt(['{"outputs":["image"],"supportedParameters":["size","quality"]}']);
  const caps = await promptServiceCapabilities(rl);
  assert.deepEqual(caps, { outputs: ['image'], supportedParameters: ['size', 'quality'] });
  assert.equal(rl.remaining(), 0);
});

test('pasted JSON is validated like config input', async () => {
  const rl = scriptedPrompt(['{"outputs":["hologram"]}']);
  await assert.rejects(
    () => promptServiceCapabilities(rl),
    /Unsupported output modality "hologram"/,
  );
});
