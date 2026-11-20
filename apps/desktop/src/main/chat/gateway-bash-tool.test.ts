import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { createGatewayBashTool } from './gateway-bash-tool.js';

async function run(tool: ReturnType<typeof createGatewayBashTool>): Promise<string> {
  const result = await tool.execute('call', { command: 'printf "%s %s" "$ANTSEED_PROXY_URL" "$ANTSEED_API_KEY"' }, undefined, undefined, {} as never);
  return (result.content[0] as { text: string }).text;
}

test('each run\'s shell sees its own gateway, even with two running at once', async () => {
  const first = createGatewayBashTool(tmpdir(), { url: 'http://one', token: 'token-one' });
  const second = createGatewayBashTool(tmpdir(), { url: 'https://two', token: 'token-two' });
  const [a, b] = await Promise.all([run(first), run(second)]);
  assert.equal(a, 'http://one token-one');
  assert.equal(b, 'https://two token-two');
});

test('the token stays out of the process environment', async () => {
  await run(createGatewayBashTool(tmpdir(), { url: 'http://one', token: 'token-one' }));
  assert.equal(process.env['ANTSEED_API_KEY'], undefined);
  assert.equal(process.env['ANTSEED_PROXY_URL'], undefined);
});
