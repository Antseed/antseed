#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../apps/ants/dist/ants-web/', import.meta.url));
const output = process.argv[2];
if (output) await mkdir(output, { recursive: true });
const address = '0x0000000000000000000000000000000000000001';
const ants = value => (BigInt(value) * 10n ** 18n).toString();
const usdc = value => (BigInt(value) * 10n ** 6n).toString();
const pool = {
  agentId: 42, seller: address, stakeable: true, hasPool: true, activeStake: ants(125000), weight: ants(2500000), powerShareBps: 1425,
  lastEpochEmission: ants(625), lastEpochRewardPer1kPower: ants(1), volumes: [1200, 2400, 1950, 3100, 2800, 4400, 5300, 4800].map((value, index) => ({ epoch: index + 15, usdc: usdc(value) })),
  volumeStatus: 'available', currentEpoch: 23, statsUpdatedAt: 1789810000000,
  yield: { epoch: 22, startsAt: 1788566400, endsAt: 1789171200, reward: ants(625), power: ants(2500000), minLockEpochs: 1, maxLockEpochs: 104, status: 'settled' },
  profile: { name: 'Example Provider', providers: ['openai-responses'], modelsServed: 3, requestCount: '251560', uniqueBuyers: 65, lifetimeVolumeUsdc: usdc(49220), ghostRate: 1.5, lastSettledAt: 1789810000 },
};
const models = {
  fetchedAt: 1789810000000, catalogStatus: 'live', catalogUpdatedAt: 1789810000000, usageStatus: 'available', usageError: null, period: { epoch: 22, from: 1789034061, to: 1789638861 }, totals: null,
  offerings: ['Model Alpha', 'Model Beta', 'Model Gamma'].map((name, index) => ({ id: String(index), name, provider: 'openai-responses', categories: [['chat', 'code'], ['image'], []][index], inputUsdPerMillion: 0.25, outputUsdPerMillion: 1.5 })),
  usage: [{ serviceId: 'alpha', name: 'Model Alpha', requests: '145', inputTokens: '89000', outputTokens: '31000', volumeUsdc: usdc(18) }],
};
const fixtures = {
  '/api/config': { address, buyerAddress: address, chainId: 'base-local', evmChainId: 31337, readOnly: true, dataDir: '' },
  '/api/overview': { phase: 'active', notices: [], epoch: { current: 23, genesis: 1775728461, epochDuration: 604800 }, wallet: { ants: ants(100), eth: ants(1), totalActiveStake: ants(1000), positionCount: 0, canTransfer: false, transfersEnabled: false } },
  '/api/pools': { source: 'indexer', pools: [pool], currentEpoch: 23, yourTotalPower: ants(5000), yourPowerShareBps: 10, totalPower: ants(10000000), explorer: 'https://antscan.co', networkVolumes: pool.volumes.map((row, index) => ({ epoch: row.epoch, usdc: usdc([40000, 52000, 45000, 62000, 50000, 58000, 72000, 60000][index]) })) },
  '/api/pools/42': pool,
  '/api/positions': { config: { minStakeEpochs: 1, maxStakeEpochs: 104 }, positions: [] },
  '/api/rewards': { total: '0', buyerUsage: { total: '0' }, legacy: { buyer: '0' } },
  '/api/jobs': [],
  [`/api/sellers/${address}/models`]: models,
};
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
  const errors = [];
  const reads = [];
  let modelEndpointMissing = false;
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'ants-pool.test') return route.abort();
    assert.equal(route.request().method(), 'GET', 'The information popup cannot submit transactions');
    if (url.pathname.startsWith('/api/')) {
      reads.push(url.pathname);
      if (modelEndpointMissing && url.pathname.endsWith('/models')) return route.fulfill({ status: 404, json: { ok: false, error: 'Not found' } });
      assert(url.pathname in fixtures, `Unexpected API: ${url.pathname}`);
      return route.fulfill({ json: { ok: true, data: fixtures[url.pathname] } });
    }
    return route.fulfill({ body: await readFile(path.join(root, url.pathname === '/' ? 'index.html' : url.pathname)), contentType: url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.addInitScript(() => { sessionStorage.setItem('ants.dashboard.token', 'mock-only'); localStorage.setItem('ants.dashboard.theme', 'dark'); });
  await page.goto('http://ants-pool.test/#/stake');
  const trigger = page.getByRole('button', { name: 'View Example Provider overview', exact: true });
  await trigger.waitFor();
  assert(!reads.some(url => url.includes('/models')), 'Model data loads only when details open');
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Example Provider' });
  await dialog.waitFor();
  await dialog.getByText('Model Gamma', { exact: true }).waitFor();
  assert.equal(await dialog.locator('.pool-catalog table').count(), 0);
  assert.deepEqual(await dialog.locator('.pool-model-tags .pill').allTextContents(), ['Model Alpha', 'Model Beta', 'Model Gamma']);
  assert.equal(await dialog.locator('.pool-catalog h5').count(), 0);
  assert.equal(await dialog.getByRole('list', { name: 'Advertised model names', exact: true }).count(), 1);
  assert(await dialog.locator('.pool-catalog').evaluate(element => element === element.parentElement.lastElementChild), 'Advertised models are the final section');
  assert(await dialog.locator('.pool-catalog').evaluate(element => !!(element.parentElement.querySelector('[aria-label="Observed model usage"]').compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)), 'Observed usage precedes the catalog');
  assert(await page.locator('[data-focus-guard]').evaluateAll(elements => elements.length > 0 && elements.every(element => !element.closest('[inert]'))), 'Shared dialog focus guards must remain active');
  if (output) await dialog.screenshot({ path: path.join(output, 'provider-overview-preview.png') });
  assert.equal(await dialog.getByRole('button', { name: /stake/i }).count(), 0);
  assert.equal(await dialog.locator('.pool-chart-line').count(), 2);
  assert.equal(await dialog.locator('.pool-chart svg').count(), 1);
  assert.equal(await dialog.getByText('View epoch data', { exact: true }).count(), 0);
  assert.equal(await dialog.getByRole('region', { name: 'Epoch volume data' }).count(), 0);
  assert.notEqual(await dialog.locator('[data-series="volume"]').getAttribute('d'), await dialog.locator('[data-series="share"]').getAttribute('d'));
  assert.deepEqual(await dialog.locator('.pool-apy-estimates dt').allTextContents(), ['1 day', '1 month', '1 year', '2 years']);
  assert.equal(await dialog.locator('.pool-apy-estimates dd').first().textContent(), 'Unsupported');
  assert.equal(await dialog.locator('.pool-metrics .pool-apy-estimates').count(), 0);
  assert.equal(await dialog.locator('.pool-metrics + .pool-apy-section .pool-apy-estimates > div').count(), 4);
  assert(!(await dialog.innerText()).includes('reference stake'), 'Reference stake stays in tooltips, not the visible caption');
  assert.equal(await dialog.locator('.volume-bars').count(), 0);
  for (const width of [1440, 1024, 768, 600, 390, 320]) {
    const height = width < 600 ? 900 : 1400;
    await page.setViewportSize({ width, height });
    const bounds = await dialog.boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    assert(bounds.y >= 0 && bounds.y + bounds.height <= height + 1);
    assert(Math.abs(bounds.x - (width - bounds.width) / 2) < 2, `Centered at ${width}px`);
    assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth + 1), false, `No popup overflow at ${width}px`);
    assert.equal(await dialog.locator('.as-modal__body').evaluate(element => element.scrollWidth > element.clientWidth + 1), false, `No content overflow at ${width}px`);
    const tileBounds = await dialog.locator('.pool-apy-estimates > div').evaluateAll(elements => elements.map(element => ({ top: element.getBoundingClientRect().top, left: element.getBoundingClientRect().left })));
    assert.equal(new Set(tileBounds.map(tile => tile.top)).size, width > 760 ? 1 : 2, `APY tile rows at ${width}px`);
    assert.equal(new Set(tileBounds.map(tile => tile.left)).size, width > 760 ? 4 : 2, `APY tile columns at ${width}px`);
    for (let index = 0; index < 8; index++) {
      await page.keyboard.press('Tab');
      await page.waitForFunction(() => document.querySelector('.pool-overview')?.contains(document.activeElement), null, { timeout: 3000 }).catch(async error => {
        console.error({ width, index, focus: await page.evaluate(() => ({ active: document.activeElement?.outerHTML.slice(0, 700), modal: document.querySelector('.pool-overview')?.getAttribute('aria-modal'), guards: [...document.querySelectorAll('[data-focus-guard]')].map(element => element.outerHTML) })) });
        throw error;
      });
      assert(await dialog.evaluate(element => element.contains(document.activeElement)), 'Keyboard focus remains in popup');
    }
    if (output && width === 390) {
      await dialog.locator('.as-modal__body').evaluate(element => { element.scrollTop = 0; });
      await dialog.screenshot({ path: path.join(output, 'provider-overview-mobile.png') });
      await dialog.getByRole('heading', { name: 'Models & usage' }).scrollIntoViewIfNeeded();
      await dialog.screenshot({ path: path.join(output, 'provider-models-mobile.png') });
      await dialog.locator('.pool-catalog').scrollIntoViewIfNeeded();
      await dialog.screenshot({ path: path.join(output, 'provider-catalog-mobile.png') });
    }
  }
  for (const theme of ['dark', 'light']) {
    await page.setViewportSize({ width: 1440, height: 1400 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await dialog.locator('.as-modal__body').evaluate(element => { element.scrollTop = 0; });
    if (output) await dialog.screenshot({ path: path.join(output, `provider-overview-${theme}.png`) });
    if (output) {
      await dialog.locator('.pool-catalog').scrollIntoViewIfNeeded();
      await dialog.screenshot({ path: path.join(output, `provider-catalog-${theme}.png`) });
    }
  }
  for (let index = 0; index < 30; index++) {
    await page.keyboard.press('Shift+Tab');
    await page.waitForFunction(() => document.querySelector('.pool-overview')?.contains(document.activeElement), null, { timeout: 3000 });
  }
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'View Example Provider overview');
  assert(await trigger.evaluate(element => element === document.activeElement), 'Closing restores focus to the provider button');
  await trigger.click();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await trigger.click();
  await page.locator('.ants-pool-overlay').click({ position: { x: 1, y: 1 } });
  await dialog.waitFor({ state: 'detached' });
  fixtures[`/api/sellers/${address}/models`] = { ...models, catalogStatus: 'unavailable', usageStatus: 'unavailable', offerings: [], usage: [] };
  await page.reload();
  await trigger.click();
  await dialog.getByText('Antscan model catalog is unavailable.', { exact: true }).waitFor();
  assert.equal(await dialog.locator('.pool-chart-line').count(), 2, 'Model errors do not hide charts');
  modelEndpointMissing = true;
  await page.reload();
  await trigger.click();
  await dialog.getByText(/Restart the updated desktop or dashboard process/).waitFor();
  assert.equal(await dialog.locator('.pool-chart-line').count(), 2);
  modelEndpointMissing = false;
  fixtures[`/api/sellers/${address}/models`] = models;
  await dialog.getByRole('button', { name: 'Retry model data' }).click();
  await dialog.getByText('Latest discovered catalog', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: informational popup; lazy model reads; one dual-axis chart; four lock-duration APYs; six viewport widths; light/dark themes; focus trap/restore; Escape, close and backdrop dismissal; model-data failures. No transactions submitted.');
} finally {
  await browser.close();
}
