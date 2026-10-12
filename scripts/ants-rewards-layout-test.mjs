#!/usr/bin/env node
/** Browser layout regression test. Build @antseed/ants first; all API data is mocked.
 * node scripts/ants-rewards-layout-test.mjs [/absolute/screenshot/directory]
 * No backend, wallet, RPC, or transaction is used.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../apps/ants/dist/ants-web/', import.meta.url));
const output = process.argv[2];
if (output) await mkdir(output, { recursive: true });
const address = '0x0000000000000000000000000000000000000001';
const buyer = '0x0000000000000000000000000000000000000002';
const pool = '0x0000000000000000000000000000000000000003';
const ants = (value) => (BigInt(value) * 10n ** 18n).toString();
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1, `${message}: ${a} vs ${b}`);
const config = { address, buyerAddress: buyer, chainId: 'base-local', evmChainId: 31337, readOnly: true, browserWallet: false, dataDir: '' };
const rewards = {
  scope: 'buyer', historySource: 'indexer', currentEpoch: 23, firstRewardedEpoch: 22, total: ants(18916),
  buyerUsage: { total: '0', epochs: [], operator: address, recipient: address, claimable: false },
  staker: { total: ants(100), positions: [{ id: 7, agentId: 42, amount: ants(100), closed: false }] },
  sellerUsage: { total: ants(150), agentId: 42, epochs: [], claimable: true },
  legacy: { buyer: '18916201600000000000000', seller: ants(600), contract: pool, buyerClaimable: false, sellerPayout: { destination: 'locked', recipient: pool } },
  locked: { locked: ants(1000), claimable: ants(100), policy: pool, pool },
};
const fixtures = {
  '/api/config': config,
  '/api/rewards': rewards,
  '/api/overview': { epoch: { current: 23, genesis: 1775728461, epochDuration: 604800 }, wallet: { canTransfer: false, eth: ants(1) } },
  '/api/positions': { config: { minStakeEpochs: 1, maxStakeEpochs: 104, stakeActivationDelay: 1 }, positions: [] },
  '/api/pools': { pools: [] },
  '/api/jobs': [],
};

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== 'http://ants-layout.test') return route.abort();
    assert.equal(request.method(), 'GET', 'Layout tests must not submit actions');
    if (url.pathname.startsWith('/api/')) {
      assert.ok(url.pathname in fixtures, `Unexpected API read: ${url.pathname}`);
      return route.fulfill({ json: { ok: true, data: fixtures[url.pathname] } });
    }
    const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
    return route.fulfill({ body: await readFile(file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.addInitScript(() => {
    sessionStorage.setItem('ants.dashboard.token', 'mock-only');
    localStorage.setItem('ants.dashboard.theme', 'dark');
  });
  await page.goto('http://ants-layout.test/#/rewards');
  const row = (name) => page.locator('.bucket').filter({ has: page.getByText(name, { exact: true }) });
  const current = row('Current buyer rewards');
  const legacy = row('Legacy buyer rewards');
  await current.waitFor();

  async function verifyLayout(width) {
    await page.setViewportSize({ width, height: 1000 });
    const amounts = await Promise.all([current, legacy].map((item) => item.locator('.bucket-amount').boundingBox()));
    if (width > 900) near(amounts[0].x + amounts[0].width, amounts[1].x + amounts[1].width, 'Amount right edges align');
    else near(amounts[0].x, amounts[1].x, 'Amount left edges align on compact layouts');
    const buttons = await Promise.all([
      current.getByRole('button', { name: 'Claim to wallet', exact: true }).boundingBox(),
      legacy.getByRole('button', { name: 'Claim to wallet', exact: true }).boundingBox(),
      current.getByRole('button', { name: 'Stake rewards', exact: true }).boundingBox(),
    ]);
    near(buttons[0].x, buttons[1].x, 'Claim buttons align');
    near(buttons[0].width, buttons[1].width, 'Claim button widths match');
    near(buttons[0].height, buttons[2].height, 'Claim and stake button heights match');
    if (width > 900) {
      const descriptions = await Promise.all([current, legacy].map((item) => item.locator('.bucket-main').boundingBox()));
      near(descriptions[0].width, descriptions[1].width, 'Descriptions use the same column');
      assert.ok(descriptions[1].x + descriptions[1].width < amounts[1].x, 'Description does not overlap amount');
    }
    const overflows = await page.evaluate(() => [...document.querySelectorAll('.bucket, .bucket-main, .bucket-amount, .confirm')].filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => element.className));
    assert.deepEqual(overflows, [], `No row content overflows at ${width}px`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No page overflow at ${width}px`);
  }

  for (const width of [1920, 1360, 1024, 901, 900, 768, 601, 600, 390, 320]) await verifyLayout(width);
  for (const [theme, width] of [['dark', 1360], ['light', 1360], ['dark', 390]]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    if (output) await page.locator('.hero').screenshot({ path: path.join(output, `buyer-rewards-${theme}-${width}.png`) });
  }

  config.readOnly = false;
  rewards.scope = 'all';
  rewards.buyerUsage.claimable = true;
  rewards.buyerUsage.total = ants(250);
  rewards.legacy.buyerClaimable = true;
  await page.reload();
  await current.getByRole('button', { name: 'Claim to wallet', exact: true }).waitFor();
  for (const width of [1360, 768, 390, 320]) {
    await verifyLayout(width);
    for (const [name, action] of [
      ['Current buyer rewards', 'Claim to wallet'],
      ['Current buyer rewards', 'Stake rewards'],
      ['Legacy seller rewards', 'Claim to locked pool'],
      ['Locked seller rewards', 'Withdraw available amount'],
    ]) {
      const item = row(name);
      await item.getByRole('button', { name: action, exact: true }).click();
      const confirmation = item.locator('.confirm');
      await confirmation.waitFor();
      const bounds = await confirmation.boundingBox();
      const rowBounds = await item.boundingBox();
      near(bounds.x, rowBounds.x, 'Confirmation starts at row edge');
      near(bounds.width, rowBounds.width, 'Confirmation spans full row width');
      const actionBounds = await item.getByRole('button', { name: action, exact: true }).boundingBox();
      assert.ok(bounds.y >= actionBounds.y + actionBounds.height, 'Confirmation stays below row actions');
      await verifyLayout(width);
      if (output && name === 'Legacy seller rewards' && [1360, 390].includes(width)) {
        await item.screenshot({ path: path.join(output, `seller-confirmation-${width}.png`) });
      }
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    }
  }
  // Large balances must not break the grid or overlap the action columns.
  rewards.legacy.buyer = ants(52000000);
  await page.reload();
  await legacy.waitFor();
  for (const width of [1360, 768, 390, 320]) await verifyLayout(width);
  assert.deepEqual(errors, []);
  console.log('PASS: aligned reward columns and button sizes at 10 viewport widths; light/dark, disabled/enabled states, full-width claim/stake/withdraw confirmations and large balances. No transactions submitted.');
} finally {
  await browser.close();
}
