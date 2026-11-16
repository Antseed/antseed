import { randomInt } from 'node:crypto'
import { deflateSync } from 'node:zlib'

/**
 * Characters a probe token is drawn from. Pairs that are easy to misread
 * (0/O/D/Q, 1/I/L, 2/Z, 5/S, 6/G, 8/B, U/V) are left out, so a wrong answer
 * points at the model rather than at the glyphs.
 */
export const TOKEN_ALPHABET = 'ACEFHJKMNPRTWXY3479'

export const TOKEN_LENGTH = 4

/** 5x7 bitmap glyphs, one string per row, `#` = ink. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
}

const GLYPH_WIDTH = 5
const GLYPH_HEIGHT = 7
/** Pixels per glyph cell. */
const SCALE = 10
/** Blank cells between glyphs and around the text. */
const GAP_CELLS = 2
const MARGIN_CELLS = 4

/** A random token for one probe, so a model can't have memorized the answer. */
export function randomToken(random: (max: number) => number = randomInt): string {
  let token = ''
  for (let i = 0; i < TOKEN_LENGTH; i++) token += TOKEN_ALPHABET[random(TOKEN_ALPHABET.length)]
  return token
}

export interface TokenBitmap {
  width: number
  height: number
  /** One byte per pixel, row-major: 0 = black ink, 255 = white paper. */
  pixels: Uint8Array
}

/** Draws `text` as large black glyphs on a white background. */
export function renderTokenBitmap(text: string): TokenBitmap {
  const chars = [...text]
  for (const char of chars) {
    if (!GLYPHS[char]) throw new Error(`no glyph for character "${char}"`)
  }
  const cellsWide = MARGIN_CELLS * 2 + chars.length * GLYPH_WIDTH + Math.max(0, chars.length - 1) * GAP_CELLS
  const cellsHigh = MARGIN_CELLS * 2 + GLYPH_HEIGHT
  const width = cellsWide * SCALE
  const height = cellsHigh * SCALE
  const pixels = new Uint8Array(width * height).fill(255)
  chars.forEach((char, index) => {
    const originCol = MARGIN_CELLS + index * (GLYPH_WIDTH + GAP_CELLS)
    GLYPHS[char]!.forEach((row, rowIndex) => {
      for (let col = 0; col < GLYPH_WIDTH; col++) {
        if (row[col] !== '#') continue
        const x0 = (originCol + col) * SCALE
        const y0 = (MARGIN_CELLS + rowIndex) * SCALE
        for (let y = y0; y < y0 + SCALE; y++) pixels.fill(0, y * width + x0, y * width + x0 + SCALE)
      }
    })
  })
  return { width, height, pixels }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const out = Buffer.alloc(typeAndData.length + 8)
  out.writeUInt32BE(data.length, 0)
  typeAndData.copy(out, 4)
  out.writeUInt32BE(crc32(typeAndData), typeAndData.length + 4)
  return out
}

/** Encodes an 8-bit grayscale bitmap as a PNG. */
export function encodeGrayscalePng(bitmap: TokenBitmap): Buffer {
  const { width, height, pixels } = bitmap
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 0 // color type: grayscale
  // compression, filter and interlace methods stay 0
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0 // filter: none
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ])
}

/** A PNG showing `token`, ready for an OCR probe. */
export function renderTokenPng(token: string): Buffer {
  return encodeGrayscalePng(renderTokenBitmap(token))
}
