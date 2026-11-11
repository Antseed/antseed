// A Responses client can send instructions as input items as well as in `instructions`. Translated for a seller that
// speaks only Chat Completions, they arrive as system instructions. The client gets a normal answer either way, so
// only what the upstream received can show it.
export const meta = {
  description: 'Responses developer and system input items reach a Chat Completions seller as one leading system message, in the order sent, and the request settles exactly.',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

export const topology = {
  mode: 'cli',
  sellers: [{ id: 'seller' }],
};

const CHAT_PATH = '/v1/chat/completions';
const INSTRUCTIONS = 'Base.\n\nStay in the sandbox.\n\nRead only.';
const PROMPT = 'Say hello.';

export async function run(tb) {
  const [seller] = tb.sellers;
  const model = seller.models[0];
  const cost = tb.mockCostPerChat(seller.id, model);
  const chats = async () => (await tb.mockRequests(seller.id)).filter((entry) => entry.path === CHAT_PATH);

  const used = { chats: (await chats()).length, channels: ((await tb.channels())[seller.id] ?? []).length };
  tb.check('scenario starts on a fresh testbench (no chats, no open channel)', used.chats === 0 && used.channels === 0, used);

  const reply = await tb.request('/v1/responses', {
    body: {
      model,
      instructions: 'Base.',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Stay in the sandbox.' }] },
        { role: 'system', content: 'Read only.' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: PROMPT }] },
      ],
    },
  });
  tb.check('the Responses client got a response', reply.status === 200 && reply.json?.object === 'response', { status: reply.status, body: reply.text.slice(0, 500) });

  const upstream = await chats();
  tb.check('the seller received one translated Chat Completions request', upstream.length === 1, upstream.map((entry) => entry.path));

  const messages = upstream[0]?.messages ?? [];
  const systems = messages.filter((message) => message.role === 'system');
  tb.check('the instructions arrived as one leading system message, in the order sent', systems.length === 1 && messages[0] === systems[0] && systems[0].content === INSTRUCTIONS, messages);
  const users = messages.filter((message) => message.role === 'user');
  tb.check('only the user turn arrived as a user message', users.length === 1 && users[0].content === PROMPT, users);

  const open = await tb.waitForPaidChannels(seller.id, { requests: 1, signed: cost });
  tb.check('buyer holds one open channel with the seller', open.length === 1, open.length);
  await tb.closeAll();
  const settlement = await tb.assertSettlementMatchesSigned(await tb.signedBySeller());
  tb.check('settled amount equals the cost of the delivered request', BigInt(settlement.totalPaidMicroUsdc) === cost, { settled: settlement.totalPaidMicroUsdc, delivered: String(cost) });
}
