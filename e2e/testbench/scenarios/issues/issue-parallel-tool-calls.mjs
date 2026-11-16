// An OpenAI-compatible upstream that streams two parallel tool calls under one `index` (told apart only by `id`).
// Converting that stream to Anthropic Messages merged both calls into one tool_use block, whose input read
// `{...}{...}`: clients failed with "Unexpected non-whitespace character after JSON". The buyer converts when the
// seller doesn't speak the request's protocol, and a seller converts when it serves a protocol its upstream doesn't.
//
// Two sellers of one model: `dual` also speaks Anthropic Messages (converting from its Chat Completions upstream),
// `chatonly` speaks only Chat Completions.
// 1. The desktop chat, Auto: the parallel calls run and the reply arrives (the surface the bug was reported on).
// 2. Anthropic Messages pinned to `chatonly` through the buyer proxy: every tool_use block parses, one per call.
import { PARALLEL_TOOLS_MARKER } from '../../lib/mock.mjs';

export const meta = {
  description: 'Parallel tool calls under one upstream index: the buyer keeps them apart when it converts to Anthropic Messages, and the desktop chat completes them.',
  targets: ['local', 'fork'],
  requires: ['desktop', 'mockControl'],
};

const MODEL = 'testbench-chat';

export const topology = {
  sellers: [
    { id: 'dual', env: { ANTSEED_SERVICE_EXTRA_PROTOCOLS_JSON: JSON.stringify({ [MODEL]: ['anthropic-messages'] }) } },
    { id: 'chatonly' },
  ],
};

/** Every tool_use block of an Anthropic Messages stream, with its input parsed the way a client parses it. */
function toolUseBlocks(sse) {
  const blocks = new Map();
  const done = [];
  for (const event of sse.split('\n\n')) {
    const line = event.split('\n').find((candidate) => candidate.startsWith('data: '));
    if (!line) continue;
    let data;
    try { data = JSON.parse(line.slice(6)); } catch { continue; }
    if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
      blocks.set(data.index, { id: data.content_block.id, name: data.content_block.name, json: '' });
    } else if (data.type === 'content_block_delta' && data.delta?.type === 'input_json_delta' && blocks.has(data.index)) {
      blocks.get(data.index).json += data.delta.partial_json;
    } else if (data.type === 'content_block_stop' && blocks.has(data.index)) {
      const block = blocks.get(data.index);
      try {
        done.push({ id: block.id, name: block.name, input: JSON.parse(block.json) });
      } catch (error) {
        done.push({ id: block.id, name: block.name, error: error.message, raw: block.json });
      }
    }
  }
  return done;
}

export async function run(tb) {
  const chatonly = tb.seller('chatonly');

  // The model's sellers as the gateway lists them: with `dual` advertising Anthropic Messages, the desktop chat
  // speaks it, and the reply is converted whichever seller answers.
  const models = await tb.request('/v1/models');
  const entry = (models.json?.data ?? []).find((model) => model.id === MODEL);
  const protocolsBySeller = Object.fromEntries((entry?.peers ?? []).map((peer) => [peer.peerId?.toLowerCase(), [peer.protocol, ...(peer.protocols ?? [])]]));
  const dualProtocols = protocolsBySeller[tb.seller('dual').peerId.toLowerCase()] ?? [];
  const chatonlyProtocols = protocolsBySeller[chatonly.peerId.toLowerCase()] ?? [];
  tb.check('dual advertises Anthropic Messages', dualProtocols.includes('anthropic-messages'), dualProtocols);
  tb.check('chatonly advertises only Chat Completions', !chatonlyProtocols.includes('anthropic-messages'), chatonlyProtocols);

  // 1. The desktop chat runs both calls and gets the reply.
  const ui = await tb.desktop();
  // testbench-chat is the only model, so the chat starts on it.
  await ui.screenshot('launched');

  // A broken reply shows as the chat's error banner, which sendChat throws; it is this check's evidence.
  const auto = await ui.sendChat(`${PARALLEL_TOOLS_MARKER} [req:desktop-auto] read both files`, { timeoutMs: 90_000 })
    .catch((error) => ({ reply: null, error: error.banner ?? error.message }));
  await ui.screenshot('auto-reply');
  tb.check('desktop Auto chat completes the parallel tool calls', Boolean(auto.reply), auto.reply ?? auto.error);

  tb.check('no renderer errors during the run', ui.errors.length === 0, ui.errors.slice(0, 5));
  await ui.close();

  // 2. The buyer's conversion, driven directly.
  const reply = await tb.request('/v1/messages', {
    stream: true,
    headers: { 'anthropic-version': '2023-06-01' },
    body: {
      model: `${chatonly.peerId}@${MODEL}`,
      max_tokens: 256,
      stream: true,
      tools: [{ name: 'read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
      messages: [{ role: 'user', content: `${PARALLEL_TOOLS_MARKER} [req:anthropic-parallel] read both files` }],
    },
  });
  tb.check('Anthropic Messages to the Chat Completions seller answers 200', reply.status === 200, { status: reply.status, body: reply.text.slice(0, 300) });
  const blocks = toolUseBlocks(reply.text);
  const broken = blocks.filter((block) => block.error);
  tb.check('every converted tool_use input parses as JSON', broken.length === 0, broken.length ? broken : blocks);
  tb.check('the two parallel calls stay two tool_use blocks', blocks.length === 2 && new Set(blocks.map((block) => block.id)).size === 2, blocks);
  tb.check('each block keeps its own arguments', blocks.map((block) => block.input?.path).sort().join(',') === 'testbench-missing-a.txt,testbench-missing-b.txt', blocks.map((block) => block.input ?? block.raw));
}
