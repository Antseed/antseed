import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { parse } from 'yaml';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decode an 8-bit RGBA PNG and return its solid-alpha (>= 200) bounding box. */
function measurePngSolidBounds(pngPath) {
  const data = readFileSync(pngPath);
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${pngPath} must be a PNG`);

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];

  let offset = 8;
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString('ascii');
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
    } else if (type === 'IDAT') {
      idatChunks.push(chunk);
    }
  }

  assert.equal(bitDepth, 8, `${pngPath} must be 8-bit`);
  assert.equal(colorType, 6, `${pngPath} must be RGBA`);

  const raw = inflateSync(Buffer.concat(idatChunks));
  const bpp = 4;
  const stride = width * bpp;
  const recon = Buffer.alloc(height * stride);

  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src++];
      const a = x >= bpp ? recon[rowStart + x - bpp] : 0;
      const b = y > 0 ? recon[prevStart + x] : 0;
      const c = y > 0 && x >= bpp ? recon[prevStart + x - bpp] : 0;
      let decoded;
      if (filter === 0) decoded = value;
      else if (filter === 1) decoded = (value + a) & 0xff;
      else if (filter === 2) decoded = (value + b) & 0xff;
      else if (filter === 3) decoded = (value + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) decoded = (value + paethPredictor(a, b, c)) & 0xff;
      else throw new Error(`Unsupported PNG filter ${filter}`);
      recon[rowStart + x] = decoded;
    }
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    for (let x = 0; x < width; x++) {
      const alpha = recon[rowStart + x * 4 + 3];
      if (alpha >= 200) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  return {
    width,
    height,
    minX,
    minY,
    maxX,
    maxY,
    solidWidth: maxX - minX + 1,
    solidHeight: maxY - minY + 1,
  };
}

test('macOS app icon conforms to the 824x824-in-1024x1024 macOS HIG canvas while Windows and Linux keep theirs', () => {
  const builderConfig = parse(readFileSync(path.join(desktopDir, 'electron-builder.yml'), 'utf8'));

  assert.equal(builderConfig.win?.icon, 'assets/antseed-dock-icon.png');
  assert.equal(builderConfig.linux?.icon, 'assets/antseed-dock-icon.png');
  assert.ok(builderConfig.mac?.icon, 'mac.icon must be configured');

  const bounds = measurePngSolidBounds(path.join(desktopDir, builderConfig.mac.icon));
  assert.equal(bounds.width, 1024);
  assert.equal(bounds.height, 1024);
  // Apple macOS App Icon HIG: 824x824 squircle centered in 1024x1024 (100px padding on every side).
  assert.equal(bounds.minX, 100);
  assert.equal(bounds.minY, 100);
  assert.equal(bounds.maxX, 923);
  assert.equal(bounds.maxY, 923);
  assert.equal(bounds.solidWidth, 824);
  assert.equal(bounds.solidHeight, 824);
});

test('packaged macOS builds keep the native bundle Dock icon instead of calling app.dock.setIcon', () => {
  const mainSource = readFileSync(path.join(desktopDir, 'src/main/main.ts'), 'utf8');
  assert.match(
    mainSource,
    /shouldSetMacDockIcon\(\s*process\.platform\s*,\s*app\.isPackaged\s*\)/,
    'app.dock.setIcon must be gated by shouldSetMacDockIcon(process.platform, app.isPackaged)',
  );
});
