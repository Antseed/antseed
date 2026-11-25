import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {walkElements, type Token} from './classFlow.ts';
import {clashingProperties, mediaCanOverlap, parseCssModule, type CssModule, type Rule} from './cssRules.ts';

const SITE = path.resolve(import.meta.dirname, '../../..');
const SRC = path.join(SITE, 'src');

const modules = new Map<string, CssModule>();
const moduleOf = (file: string) => {
  if (!modules.has(file)) modules.set(file, fs.existsSync(file) ? parseCssModule(file) : {rules: [], composes: new Map()});
  return modules.get(file)!;
};

/** The classes an element really carries: its own plus everything they compose. */
function withComposed(tokens: readonly Token[]): Map<string, Set<string>> {
  const byModule = new Map<string, Set<string>>();
  const queue = tokens.filter((t): t is [string, string] => t[0] !== null);
  while (queue.length) {
    const [file, name] = queue.pop()!;
    const set = byModule.get(file) ?? new Set<string>();
    if (set.has(name)) continue;
    byModule.set(file, set.add(name));
    queue.push(...(moduleOf(file).composes.get(name) ?? []));
  }
  return byModule;
}

/** `.row:nth-child(2)` and `.row:nth-child(3)`, `[data-set='day']` and `[data-set='night']`: one element is never both. */
const STATE = /:nth-(?:child|of-type)\(\s*\d+\s*\)|\[[\w-]+=['"]?[^'"\]]*['"]?\]/g;
function exclusiveStates(a: string, b: string): boolean {
  if (a.replace(STATE, '#') !== b.replace(STATE, '#')) return false;
  const [x, y] = [a.match(STATE) ?? [], b.match(STATE) ?? []];
  return x.some((s, i) => s !== y[i]);
}

const label = (r: Rule) => `${path.relative(SRC, r.module)} ${r.selector}${r.media ? ` (${r.media})` : ''}`;
const sameSpecificity = (a: Rule, b: Rule) => a.specificity.every((n, i) => n === b.specificity[i]);

/**
 * The production build's CSS minifier may merge and reorder rules of equal specificity, within one module and across modules (chunks
 * load in any order). Two rules that can style the same element and set the same property must therefore differ in specificity:
 * the one meant to win is structurally stronger (`.base.modifier`, `.section .point`), never just later in the file.
 */
test('rules that can style one element never tie on a property', () => {
  const files = (fs.readdirSync(SRC, {recursive: true}) as string[]).filter((f) => f.endsWith('.tsx')).map((f) => path.join(SRC, f));
  const candidates = new Map<string, {a: Rule; b: Rule; message: string}>();
  const exclusive = walkElements(files, SITE, ({where, tokens, rendered}) => {
    const classes = withComposed(tokens);
    // a rule's ancestor classes from a module this rendering draws must be somewhere in it
    const drawn = (r: Rule) => r.context.every((c) => rendered.has(`${r.module}\0${c}`) || ![...rendered].some((k) => k.startsWith(`${r.module}\0`)));
    const rules = [...classes].flatMap(([file, names]) => moduleOf(file).rules.filter((r) => r.classes.length && r.classes.every((c) => names.has(c)) && drawn(r)));
    for (let i = 0; i < rules.length; i++) {
      for (let j = i + 1; j < rules.length; j++) {
        const [a, b] = [rules[i], rules[j]];
        if (a.selector === b.selector && a.module === b.module && !a.declarations.has('all') && !b.declarations.has('all')) continue;
        if (a.pseudoElement !== b.pseudoElement || (a.tag && b.tag && a.tag !== b.tag) || !sameSpecificity(a, b) || !mediaCanOverlap(a.media, b.media)) continue;
        const props = clashingProperties(a, b);
        if (!props.length) continue;
        const key = [label(a), label(b)].sort().join(' | ');
        if (!candidates.has(key)) candidates.set(key, {a, b, message: `${key}: ${props.join(', ')} — on ${where}`});
      }
    }
  });
  // `.page .title` and `.wide .title` never meet: one className expression sets either .page or .wide
  const apart = (a: Rule, b: Rule) => a.module === b.module && (exclusiveStates(a.selector, b.selector)
    || a.excludes.some((c) => b.classes.includes(c)) || b.excludes.some((c) => a.classes.includes(c))
    || [...a.context, ...a.classes].some((x) => [...b.context, ...b.classes].some((y) => exclusive(a.module, x, y))));
  const found = [...candidates.values()].filter(({a, b}) => !apart(a, b)).map((c) => c.message);
  assert.deepEqual(found.sort(), []);
});

/**
 * The minifier moves declarations out of a rule to merge them with an identical one elsewhere, and it does not count `all` as a
 * conflict: `.x { all: unset; max-width: 300px }` can ship as `.x, .y { max-width: 300px }` … `.x { all: unset }`. A reset with `all`
 * stands alone, and whatever styles the element after it is structurally stronger.
 */
test('an `all` reset is the only declaration in its rule', () => {
  const css = (fs.readdirSync(SRC, {recursive: true}) as string[]).filter((f) => f.endsWith('.module.css'));
  const mixed = css.flatMap((f) => moduleOf(path.join(SRC, f)).rules)
    .filter((r) => r.declarations.has('all') && r.declarations.size > 1)
    .map(label);
  assert.deepEqual([...new Set(mixed)], []);
});
