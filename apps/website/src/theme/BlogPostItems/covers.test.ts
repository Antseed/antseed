import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SITE = path.resolve(import.meta.dirname, '../../..');

// The blog cards show a post's share image as WebP (index.tsx, webpOf): every share image other than the site default has its twin.
test('every post share image has a WebP twin', () => {
  const missing: string[] = [];
  for (const file of fs.readdirSync(path.join(SITE, 'blog'), {recursive: true}) as string[]) {
    if (!/\.mdx?$/.test(file)) continue;
    const image = /^image: (\/\S+\.(?:png|jpe?g))$/m.exec(fs.readFileSync(path.join(SITE, 'blog', file), 'utf8'))?.[1];
    if (!image || image === '/og-image.jpg') continue;
    if (!fs.existsSync(path.join(SITE, 'static', image.replace(/\.(png|jpe?g)$/, '.webp')))) missing.push(`${file}: ${image}`);
  }
  assert.deepEqual(missing, []);
});
