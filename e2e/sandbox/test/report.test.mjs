import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { writeHtmlReport } from '../lib/report-html.mjs';
import { reportFilePath, serveReports } from '../lib/report-server.mjs';

const report = {
  scenario: 'desktop-chat', description: 'x <b>', result: 'failed', sandbox: 'wt-a', upstream: 'mock', forkBlock: 1,
  startedAt: 's', finishedAt: 'f', error: 'boom <script>',
  checks: [{ name: 'ok one', ok: true }, { name: 'bad one', ok: false, detail: { a: '<i>' } }],
  knownIssues: [{ name: 'tracked', ok: false, issue: 'bug-1' }], metrics: { latency: 5 },
};

describe('html report', () => {
  it('renders checks, media and escapes untrusted text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-report-'));
    await mkdir(join(dir, 'screenshots'));
    await mkdir(join(dir, 'video'));
    await writeFile(join(dir, 'screenshots', '01-launched.png'), '');
    await writeFile(join(dir, 'video', 'desktop.webm'), '');
    await writeFile(join(dir, 'events.jsonl'), '{"type":"chat"}\n');
    const html = await readFile(await writeHtmlReport(dir, report), 'utf8');
    assert.match(html, /FAILED/);
    assert.match(html, /screenshots\/01-launched\.png/);
    assert.match(html, /<video src="video\/desktop\.webm"/);
    assert.match(html, /KNOWN/);
    assert.doesNotMatch(html, /<script>|<b>|<i>/);
  });
});

describe('report server', () => {
  it('stays inside the reports dir and serves files with ranges', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-serve-'));
    await mkdir(join(dir, 'run1'));
    await writeFile(join(dir, 'run1', 'index.html'), '<h1>hi</h1>');
    await writeFile(join(dir, 'run1', 'secret.key'), 'nope');
    assert.equal(reportFilePath(dir, '/../etc/passwd'), null);
    assert.equal(reportFilePath(dir, '/%2e%2e/x'), null);
    const server = await serveReports({ dir });
    try {
      assert.equal(server.host, '127.0.0.1');
      assert.match(await (await fetch(server.url)).text(), /run1/);
      assert.equal(await (await fetch(`${server.url}run1/index.html`)).text(), '<h1>hi</h1>');
      assert.equal((await fetch(`${server.url}run1/secret.key`)).status, 403);
      const partial = await fetch(`${server.url}run1/index.html`, { headers: { range: 'bytes=0-3' } });
      assert.equal(partial.status, 206);
      assert.equal(await partial.text(), '<h1>');
    } finally {
      await server.stop();
    }
  });
});
