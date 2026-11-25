import fs from 'node:fs';
import path from 'node:path';

/** One selector of a CSS module rule, reduced to what decides whether it can tie with another on the same element. */
export type Rule = {
  module: string;
  selector: string;
  /** The module's own classes the selected element must carry (its last compound's top-level classes); none for `.list a`. */
  classes: readonly string[];
  /** The module's own classes some ancestor (or sibling, across `+`/`~`) must carry. */
  context: readonly string[];
  /** Classes the last compound rules out (`:not(.copied)`). */
  excludes: readonly string[];
  /** The element type the last compound names (`td` in `.row td.good`), if any. */
  tag: string;
  pseudoElement: string;
  specificity: readonly [number, number, number];
  media: string;
  declarations: ReadonlyMap<string, string>;
};

export type CssModule = {
  rules: Rule[];
  /** class → the classes `composes:` adds to the element, as [module, class]. */
  composes: Map<string, [string, string][]>;
};

type Specificity = [number, number, number];

const add = (a: Specificity, b: readonly number[]): Specificity => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const max = (list: Specificity[]): Specificity =>
  list.reduce<Specificity>((m, s) => (s[0] - m[0] || s[1] - m[1] || s[2] - m[2]) > 0 ? s : m, [0, 0, 0]);

/** Splits at top-level occurrences of `sep` (outside parentheses, brackets and quotes). */
function splitTop(text: string, sep: (ch: string) => boolean): string[] {
  const parts: string[] = [];
  let depth = 0, quote = '', start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth === 0 && sep(ch)) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

const compoundsOf = (selector: string) => splitTop(selector, (ch) => /[\s>+~]/.test(ch));

/** The simple selectors of one compound: `.a`, `#b`, `[c]`, `:d(…)`, `::e`, `f`, `*`. */
function simplesOf(compound: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < compound.length) {
    let j = i + 1;
    if (compound[i] === ':' && compound[j] === ':') j++;
    if (compound[i] === '[') {
      while (j < compound.length && compound[j - 1] !== ']') j++;
    } else {
      while (j < compound.length && !/[.#[:]/.test(compound[j]) && compound[j] !== '(') j++;
      if (compound[j] === '(') {
        let depth = 0;
        for (; j < compound.length; j++) {
          if (compound[j] === '(') depth++;
          else if (compound[j] === ')' && --depth === 0) { j++; break; }
        }
      }
    }
    out.push(compound.slice(i, j));
    i = j;
  }
  return out;
}

const argsOf = (simple: string) => simple.slice(simple.indexOf('(') + 1, -1);

export function specificityOf(selector: string): Specificity {
  let total: Specificity = [0, 0, 0];
  for (const compound of compoundsOf(selector)) {
    for (const s of simplesOf(compound)) {
      if (s.startsWith('::') || /^:(before|after)$/.test(s)) total = add(total, [0, 0, 1]);
      else if (/^:(global|is|not|has|matches)\(/.test(s)) total = add(total, max(splitTop(argsOf(s), (c) => c === ',').map(specificityOf)));
      else if (s.startsWith(':where(')) continue;
      else if (s[0] === '.' || s[0] === '[' || s[0] === ':') total = add(total, [0, 1, 0]);
      else if (s[0] === '#') total = add(total, [1, 0, 0]);
      else if (s !== '*') total = add(total, [0, 0, 1]);
    }
  }
  return total;
}

function declarationsOf(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const decl of splitTop(body, (ch) => ch === ';')) {
    const colon = decl.indexOf(':');
    if (colon > 0) out.set(decl.slice(0, colon).trim().toLowerCase(), decl.slice(colon + 1).trim().replace(/\s+/g, ' '));
  }
  return out;
}

/** Reads a CSS module: every style rule (inside `@media`/`@supports`/`@container` too) and its `composes:` lines. */
export function parseCssModule(file: string): CssModule {
  const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const module: CssModule = {rules: [], composes: new Map()};
  const walk = (block: string, media: string) => {
    let i = 0;
    while (i < block.length) {
      const open = block.indexOf('{', i);
      if (open < 0) return;
      let depth = 1, close = open + 1;
      for (; close < block.length && depth; close++) {
        if (block[close] === '{') depth++;
        else if (block[close] === '}') depth--;
      }
      const prelude = block.slice(i, open).replace(/^[\s\S]*;/, '').trim();
      const body = block.slice(open + 1, close - 1);
      i = close;
      if (/^@(media|supports|container)/.test(prelude)) walk(body, `${media} ${prelude}`.trim());
      else if (!prelude.startsWith('@')) addRule(module, file, prelude, body, media);
    }
  };
  walk(text, '');
  return module;
}

function addRule(module: CssModule, file: string, prelude: string, body: string, media: string) {
  const declarations = declarationsOf(body);
  const composes = declarations.get('composes');
  declarations.delete('composes');
  for (const selector of splitTop(prelude, (ch) => ch === ',')) {
    const compounds = compoundsOf(selector);
    const last = simplesOf(compounds[compounds.length - 1] ?? '');
    const classes = last.filter((s) => s[0] === '.').map((s) => s.slice(1));
    if (composes && compounds.length === 1 && classes.length === 1) {
      const [, names, from] = /^(.*?)(?:\s+from\s+['"](.+)['"])?$/.exec(composes)!;
      const target = from ? path.resolve(path.dirname(file), from) : file;
      if (from !== 'global') module.composes.set(classes[0], names.split(/\s+/).map((n): [string, string] => [target, n]));
    }
    if (!declarations.size) continue;
    const context = compounds.slice(0, -1).flatMap((c) => simplesOf(c).flatMap((x) =>
      x[0] === '.' ? [x.slice(1)] : /^:(where|is)\(\.[\w-]+\)$/.test(x) ? [argsOf(x).slice(1)] : []));
    module.rules.push({
      module: file,
      selector,
      classes,
      context,
      excludes: last.flatMap((x) => (/^:not\(\.[\w-]+\)$/.test(x) ? [argsOf(x).slice(1)] : [])),
      tag: last.find((x) => /^[a-z]/i.test(x)) ?? '',
      pseudoElement: last.find((s) => s.startsWith('::') || /^:(before|after)$/.test(s))?.replace(/^::?/, '') ?? '',
      specificity: specificityOf(selector),
      media,
      declarations,
    });
  }
}

const PREFIX_SHORTHANDS = new Set([
  'animation', 'background', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-block', 'border-inline',
  'border-width', 'border-style', 'border-color', 'column-rule', 'font', 'grid-template', 'list-style', 'margin', 'mask', '-webkit-mask',
  'outline', 'overflow', 'padding', 'scroll-margin', 'scroll-padding', 'text-decoration', 'transition', 'inset', 'grid-row', 'grid-column',
]);
const EXPLICIT_SHORTHANDS: Record<string, readonly string[]> = {
  inset: ['top', 'right', 'bottom', 'left'],
  font: ['line-height'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  'flex-flow': ['flex-direction', 'flex-wrap'],
  gap: ['row-gap', 'column-gap'],
  'place-items': ['align-items', 'justify-items'],
  'place-content': ['align-content', 'justify-content'],
  'place-self': ['align-self', 'justify-self'],
  'grid-area': ['grid-row', 'grid-column', 'grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end'],
  grid: ['grid-template', 'grid-template-rows', 'grid-template-columns', 'grid-template-areas', 'grid-auto-flow', 'grid-auto-rows', 'grid-auto-columns'],
};

const covers = (a: string, b: string) =>
  (a === 'all' && !b.startsWith('--') && b !== 'direction' && b !== 'unicode-bidi')
  || (PREFIX_SHORTHANDS.has(a) && b.startsWith(`${a}-`) && !(a.startsWith('border') && b.endsWith('radius')))
  || (EXPLICIT_SHORTHANDS[a]?.includes(b) ?? false);

/** Two declarations that write the same property (or a shorthand and its longhand) to different values, neither `!important`. */
export function clashingProperties(a: Rule, b: Rule): string[] {
  const out: string[] = [];
  for (const [pa, va] of a.declarations) {
    for (const [pb, vb] of b.declarations) {
      if (pa !== pb && !covers(pa, pb) && !covers(pb, pa)) continue;
      if (pa === pb && va === vb) continue;
      if (va.endsWith('!important') !== vb.endsWith('!important')) continue;
      out.push(pa === pb ? pa : `${pa}/${pb}`);
    }
  }
  return out;
}

type Conditions = {min: number; max: number; features: Map<string, string>};

function conditionsOf(media: string): Conditions | null {
  if (media.includes(',')) return null;
  const out: Conditions = {min: 0, max: Infinity, features: new Map()};
  for (const segment of media.split(/(?=@)/)) {
    const viewport = segment.startsWith('@media');
    for (const [, feature, value] of segment.matchAll(/\(\s*([a-z-]+)\s*:\s*([^)]+?)\s*\)/g)) {
      if (viewport && feature === 'max-width') out.max = Math.min(out.max, parseFloat(value));
      else if (viewport && feature === 'min-width') out.min = Math.max(out.min, parseFloat(value));
      else if (/^(prefers-|hover|pointer)/.test(feature)) out.features.set(feature, value);
    }
  }
  return out;
}

/** Whether two rules' `@media` conditions can hold at once (viewport widths that overlap, no opposite preference). */
export function mediaCanOverlap(a: string, b: string): boolean {
  const [x, y] = [conditionsOf(a), conditionsOf(b)];
  if (!x || !y) return true;
  if (Math.max(x.min, y.min) > Math.min(x.max, y.max)) return false;
  for (const [feature, value] of x.features) if (y.features.has(feature) && y.features.get(feature) !== value) return false;
  return true;
}
