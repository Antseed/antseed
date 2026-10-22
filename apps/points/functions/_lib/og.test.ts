import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { onRequestGet } from '../u/[handle]';
import type { Env, KV } from './env';
import { injectMeta, profileMeta } from './og';
import { link } from './store';

const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const metaContent = (html: string, attr: string, key: string) =>
  new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`).exec(html)?.[1];

function env(): Env {
  const data = new Map<string, string>();
  const kv: KV = {
    get: async (k) => data.get(k) ?? null,
    put: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
  return {
    PROFILES: kv,
    SESSION_SECRET: 'test',
    PUBLIC_URL: 'https://points.example',
    ASSETS: { fetch: async () => new Response(indexHtml, { headers: { 'content-type': 'text/html; charset=utf-8', etag: '"abc"' } }) },
  };
}

const get = (e: Env, handle: string) =>
  onRequestGet({ request: new Request(`https://points.example/u/${handle}`), env: e, params: { handle } });

describe('profile link previews', () => {
  it('swaps the generic tags for the profile and its card, once each', () => {
    const now = Date.parse('2026-10-21T12:00:00Z'); // epoch 27
    const html = injectMeta(indexHtml, profileMeta({ handle: 'alice', name: 'Alice "A" <Ants>' }, 'https://points.example', now));
    expect(html).toContain('<title>Alice &quot;A&quot; &lt;Ants&gt; (@alice) on Antseed Points</title>');
    expect(metaContent(html, 'name', 'twitter:card')).toBe('summary_large_image');
    expect(metaContent(html, 'property', 'og:image')).toBe('https://points.example/api/card/alice.png?e=27');
    expect(metaContent(html, 'name', 'twitter:image')).toBe('https://points.example/api/card/alice.png?e=27');
    expect(metaContent(html, 'property', 'og:url')).toBe('https://points.example/u/alice');
    for (const key of ['og:title', 'og:description', 'twitter:card', 'description']) {
      expect(html.match(new RegExp(`(name|property)="${key}"`, 'g'))).toHaveLength(1);
    }
    expect(html.match(/<title>/g)).toHaveLength(1);
    // The SPA itself is untouched.
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('src="/src/main.tsx"');
  });

  it('serves the page with profile tags for a linked handle, in any case', async () => {
    const e = env();
    await link(e.PROFILES, { xId: '1', handle: 'Alice', name: 'Alice Ant', avatar: '' }, '0x00aa55469de149edbc5487ccbf30439a2b8bf98c', '0x00aa55469de149edbc5487ccbf30439a2b8bf98c');
    const res = await get(e, 'alice');
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeNull();
    const html = await res.text();
    expect(metaContent(html, 'property', 'og:title')).toBe('Alice Ant (@Alice) on Antseed Points');
    expect(metaContent(html, 'property', 'og:image')).toMatch(/^https:\/\/points\.example\/api\/card\/Alice\.png\?e=\d+$/);
    expect(html).toContain('<div id="root"></div>');
  });

  it('falls back to the plain page for unknown handles', async () => {
    const res = await get(env(), 'nobody');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(indexHtml);
  });
});
