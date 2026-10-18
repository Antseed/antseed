import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const detail = (value) => (value === undefined ? '' : escape(typeof value === 'string' ? value : JSON.stringify(value)));

/** Self-contained index.html for one run: result, checks, metrics, screenshots, video, events. Relative links only. */
export async function writeHtmlReport(reportDir, report) {
  const shots = existsSync(join(reportDir, 'screenshots')) ? (await readdir(join(reportDir, 'screenshots'))).filter((name) => name.endsWith('.png')).sort() : [];
  const videos = existsSync(join(reportDir, 'video')) ? (await readdir(join(reportDir, 'video'))).filter((name) => name.endsWith('.webm')).sort((a, b) => (a === 'desktop.webm' ? -1 : b === 'desktop.webm' ? 1 : a.localeCompare(b))) : [];
  const trace = existsSync(join(reportDir, 'trace.zip'));
  const events = existsSync(join(reportDir, 'events.jsonl')) ? (await readFile(join(reportDir, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean) : [];
  const passed = report.result === 'passed';
  const rows = (items, issue) => items.map((item) => `<tr class="${item.ok ? 'ok' : issue ? 'known' : 'bad'}"><td>${item.ok ? 'PASS' : issue ? 'KNOWN' : 'FAIL'}</td><td>${escape(item.name)}${item.issue ? `<div class="muted">${escape(item.issue)}</div>` : ''}</td><td><code>${detail(item.detail)}</code></td></tr>`).join('');
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escape(report.scenario)} — ${escape(report.result)}</title>
<style>
body{font:14px/1.45 -apple-system,system-ui,sans-serif;margin:24px auto;max-width:1100px;padding:0 16px;color:#1d1d1f}
h1{margin:0 0 4px}.badge{display:inline-block;padding:2px 10px;border-radius:12px;color:#fff;background:${passed ? '#1a7f37' : '#cf222e'}}
.muted{color:#6e7781;font-size:12px}table{border-collapse:collapse;width:100%;margin:8px 0 20px}td,th{border-bottom:1px solid #d0d7de;padding:6px 8px;text-align:left;vertical-align:top}
tr.ok td:first-child{color:#1a7f37}tr.bad td:first-child{color:#cf222e;font-weight:600}tr.known td:first-child{color:#9a6700}
code{font-size:12px;word-break:break-all}.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.shots figure{margin:0}.shots img{width:100%;border:1px solid #d0d7de;border-radius:6px}video{width:100%;border-radius:6px;background:#000}
pre{background:#f6f8fa;padding:12px;border-radius:6px;overflow:auto;max-height:360px;font-size:12px}
</style></head><body>
<h1>${escape(report.scenario)} <span class="badge">${escape(report.result.toUpperCase())}</span></h1>
<div class="muted">${escape(report.description)}</div>
<p class="muted">sandbox ${escape(report.sandbox)} · upstream ${escape(report.upstream)} · fork block ${escape(report.forkBlock)} · ${escape(report.startedAt)} → ${escape(report.finishedAt)}</p>
${report.error ? `<pre>${escape(report.error)}</pre>` : ''}
<h2>Checks</h2><table>${rows(report.checks ?? [])}${rows(report.knownIssues ?? [], true)}</table>
<h2>Metrics</h2><table>${Object.entries(report.metrics ?? {}).map(([key, value]) => `<tr><td>${escape(key)}</td><td><code>${detail(value)}</code></td></tr>`).join('')}</table>
${videos.length ? `<h2>Video</h2>${videos.map((name) => `<video src="video/${escape(name)}" controls preload="metadata"></video><div class="muted">${escape(name)}</div>`).join('')}` : ''}
${shots.length ? `<h2>Screenshots</h2><div class="shots">${shots.map((name) => `<figure><a href="screenshots/${escape(name)}"><img src="screenshots/${escape(name)}" loading="lazy"></a><figcaption class="muted">${escape(name)}</figcaption></figure>`).join('')}</div>` : ''}
${trace ? `<h2>Trace</h2><p>Step-by-step replay (DOM, actions, network): <code>npx playwright show-trace ${escape(join(reportDir, 'trace.zip'))}</code></p>` : ''}
<h2>Events</h2><pre>${escape(events.join('\n'))}</pre>
<p class="muted"><a href="report.json">report.json</a> · <a href="events.jsonl">events.jsonl</a>${existsSync(join(reportDir, 'desktop-main.log')) ? ' · <a href="desktop-main.log">desktop-main.log</a>' : ''}</p>
</body></html>
`;
  const path = join(reportDir, 'index.html');
  await writeFile(path, html, { mode: 0o600 });
  return path;
}
