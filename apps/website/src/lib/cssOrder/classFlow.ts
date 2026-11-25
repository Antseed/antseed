import path from 'node:path';
import type * as t from '@babel/types';
import {conditionsOf, literalOf, merge, NO_FACTS, valueFact, type Facts} from './facts.ts';
import {componentFn, isFunction, isNode, load, nameOf, resolveTag, walk, type Fn, type SourceFile} from './sources.ts';

/** A CSS module class as `[module file, class]`, or a className-like prop the component forwards as `[null, prop]`. */
export type Token = readonly [string | null, string];
/** One set of tokens an element can carry at once, and what must hold for it. */
type Combo = {tokens: readonly Token[]; facts: Facts};

const MAX_COMBOS = 512;
const MAX_DEPTH = 8;
const CLASS_ATTR = /^(className|[a-z]\w*ClassName)$/;
function product(a: Combo[], b: Combo[]): Combo[] {
  const out: Combo[] = [];
  for (const x of a) {
    for (const y of b) {
      const facts = merge(x.facts, y.facts);
      if (facts && out.length < MAX_COMBOS) out.push({tokens: [...x.tokens, ...y.tokens], facts});
    }
  }
  return out;
}
const EMPTY: Combo[] = [{tokens: [], facts: NO_FACTS}];
const withFacts = (list: Facts[], combos: Combo[]) => product(list.map((facts) => ({tokens: [], facts})), combos);

/** The component's props by local binding: `{className, titleClassName: cls, as: Tag = 'h2'}`. */
function bindingsOf(fn: Fn): Map<string, {prop: string; fallback: t.Node | null}> {
  const out = new Map<string, {prop: string; fallback: t.Node | null}>();
  for (const p of fn.params) {
    if (p.type !== 'ObjectPattern') continue;
    for (const prop of p.properties) {
      if (prop.type !== 'ObjectProperty') continue;
      const value = prop.value.type === 'AssignmentPattern' ? prop.value.left : prop.value;
      const fallback = prop.value.type === 'AssignmentPattern' ? prop.value.right : null;
      if (value.type === 'Identifier') out.set(value.name, {prop: nameOf(prop.key), fallback});
    }
  }
  return out;
}

function initializerOf(name: string, fn: Fn, src: SourceFile): t.Node | null {
  let found: t.Node | null = null;
  walk(fn, (n) => {
    if (found) return false;
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === name && n.init) found = n.init;
  });
  const top = src.declarations.get(name);
  return found ?? (top && !isFunction(top) ? top : null);
}

/** Every combination of tokens a className expression can produce, each with the conditions it needs. */
function combos(e: t.Node, src: SourceFile, fn: Fn, depth = 0): Combo[] {
  const again = (x: t.Node) => combos(x, src, fn, depth + 1);
  const all = (list: t.Node[]) => list.reduce<Combo[]>((acc, x) => product(acc, again(x)), EMPTY);
  if (depth > 12) return EMPTY;
  switch (e.type) {
    case 'TSAsExpression': case 'TSNonNullExpression': case 'TSSatisfiesExpression': case 'ParenthesizedExpression':
      return again(e.expression);
    case 'MemberExpression': {
      if (e.object.type !== 'Identifier') return EMPTY;
      if (e.object.name !== src.styles) {
        // a lookup table of classes: `SIZE_CLASS[size]` is any of its values
        const table = initializerOf(e.object.name, fn, src);
        if (table?.type !== 'ObjectExpression') return EMPTY;
        const key = e.computed ? null : nameOf(e.property);
        return table.properties.flatMap((p) => (p.type === 'ObjectProperty' && (!key || nameOf(p.key) === key) ? again(p.value) : []));
      }
      const name = !e.computed ? nameOf(e.property) : e.property.type === 'StringLiteral' ? e.property.value : '';
      return name ? [{tokens: [[src.stylesFile, name]], facts: NO_FACTS}] : EMPTY;
    }
    case 'CallExpression':
      if (e.callee.type === 'Identifier' && e.callee.name === 'clsx') return all(e.arguments);
      if (e.callee.type === 'MemberExpression' && nameOf(e.callee.property) === 'join') return again(e.callee.object);
      return EMPTY;
    case 'ArrayExpression':
      return all(e.elements.filter(isNode));
    case 'TemplateLiteral':
      return all(e.expressions);
    case 'ObjectExpression':
      return e.properties.reduce<Combo[]>((acc, p) => (p.type === 'ObjectProperty' && p.computed
        ? product(acc, [...withFacts(conditionsOf(p.value, true), again(p.key)), ...withFacts(conditionsOf(p.value, false), EMPTY)])
        : acc), EMPTY);
    case 'ConditionalExpression':
      return [...withFacts(conditionsOf(e.test, true), again(e.consequent)), ...withFacts(conditionsOf(e.test, false), again(e.alternate))];
    case 'LogicalExpression':
      if (e.operator === '&&') return [...withFacts(conditionsOf(e.left, true), again(e.right)), ...withFacts(conditionsOf(e.left, false), EMPTY)];
      return [...again(e.left), ...withFacts(conditionsOf(e.left, false), again(e.right))];
    case 'BinaryExpression':
      return e.operator === '+' ? product(again(e.left), again(e.right)) : EMPTY;
    case 'Identifier': {
      const binding = bindingsOf(fn).get(e.name);
      if (binding) return [{tokens: [[null, binding.prop]], facts: NO_FACTS}];
      const init = initializerOf(e.name, fn, src);
      return init ? again(init) : EMPTY;
    }
    default:
      return EMPTY;
  }
}

type Element = {tag: string; line: number; classAttrs: Map<string, t.Node>; props: Map<string, t.Node | true | null>; spread: boolean};

const elementCache = new WeakMap<Fn, Element[]>();

function elementsOf(fn: Fn): Element[] {
  const cached = elementCache.get(fn);
  if (cached) return cached;
  const out: Element[] = [];
  elementCache.set(fn, out);
  walk(fn, (n) => {
    if (n.type !== 'JSXOpeningElement') return;
    const el: Element = {tag: n.name.type === 'JSXIdentifier' ? n.name.name : '', line: n.loc?.start.line ?? 0, classAttrs: new Map(), props: new Map(), spread: false};
    for (const a of n.attributes) {
      if (a.type === 'JSXSpreadAttribute') { el.spread = true; continue; }
      const name = nameOf(a.name);
      const value = a.value?.type === 'JSXExpressionContainer' ? (a.value.expression.type === 'JSXEmptyExpression' ? null : a.value.expression) : a.value ?? true;
      if (CLASS_ATTR.test(name) && value && value !== true) el.classAttrs.set(name, value);
      else el.props.set(name, value);
    }
    out.push(el);
  });
  return out;
}

/** What a component knows about its props from one call site: literal values, a default for the absent ones, or nothing. */
function factsFromCall(fn: Fn, call: Element | null): Facts {
  if (!call) return NO_FACTS;
  let facts: Facts | null = NO_FACTS;
  for (const [local, {prop, fallback}] of bindingsOf(fn)) {
    const given = call.props.get(prop);
    const value = given === true ? true : given ?? (call.spread ? undefined : fallback ?? null);
    if (value === undefined) continue;
    const literal = value === true ? true : value === null ? null : literalOf(value);
    if (literal !== undefined) facts = facts && merge(facts, valueFact(local, literal));
  }
  return facts ?? NO_FACTS;
}

/** One element of one rendering: the module classes it can carry at once, and every module class that rendering puts anywhere. */
export type ElementClasses = {where: string; tokens: readonly Token[]; rendered: ReadonlySet<string>};
/** Classes that sit in one className expression but never together (`size === 'page' ? styles.page : styles.wide`). */
export type Exclusive = (module: string, a: string, b: string) => boolean;

/**
 * Walks every component, following className-like props into the components that receive them (with the literal props of that call),
 * and reports each set of module classes one DOM element can carry at once.
 */
export function walkElements(files: readonly string[], site: string, onElement: (e: ElementClasses) => void): Exclusive {
  const siblings = new Set<string>();
  const together = new Set<string>();
  const pairKey = (m: string, a: string, b: string) => `${m}\0${[a, b].sort().join('\0')}`;
  const note = (all: Combo[]) => {
    const local = all.flatMap((c) => c.tokens).filter((tok): tok is [string, string] => tok[0] !== null);
    for (const [m, a] of local) for (const [n, b] of local) if (m === n && a !== b) siblings.add(pairKey(m, a, b));
    for (const c of all) for (const [m, a] of c.tokens) for (const [n, b] of c.tokens) if (m && m === n && a !== b) together.add(pairKey(m, a, b));
  };

  const visit = (src: SourceFile, fn: Fn, call: Element | null, incoming: Map<string, Token[][]>, outer: Set<string>, chain: string, depth: number) => {
    const known = factsFromCall(fn, call);
    const found: {el: Element; attr: string; tokens: Token[]}[] = [];
    for (const el of elementsOf(fn)) {
      for (const [attr, expr] of el.classAttrs) {
        const own = combos(expr, src, fn).filter((c) => merge(c.facts, known));
        note(own);
        for (const c of own) {
          let options: Token[][] = [[]];
          for (const tok of c.tokens) {
            const add = tok[0] === null ? incoming.get(tok[1]) ?? [[]] : [[tok]];
            options = options.flatMap((o) => add.map((x) => [...o, ...x])).slice(0, MAX_COMBOS);
          }
          for (const tokens of options) if (tokens.length) found.push({el, attr, tokens});
        }
      }
    }
    const rendered = new Set(outer);
    for (const {tokens} of found) for (const [m, c] of tokens) if (m) rendered.add(`${m}\0${c}`);
    const forwarded = new Map<Element, Map<string, Token[][]>>();
    for (const {el, attr, tokens} of found) {
      if (/^[A-Z]/.test(el.tag) && resolveTag(src, el.tag, site)) {
        const props = forwarded.get(el) ?? new Map<string, Token[][]>();
        forwarded.set(el, props.set(attr, [...(props.get(attr) ?? []), tokens]));
      } else if (attr === 'className') {
        onElement({where: `${chain}${path.relative(site, src.file)}:${el.line}`, tokens, rendered});
      }
    }
    if (depth >= MAX_DEPTH) return;
    for (const el of elementsOf(fn)) {
      if (!/^[A-Z]/.test(el.tag)) continue;
      const target = resolveTag(src, el.tag, site);
      const props = forwarded.get(el);
      if (target && props) visit(target.src, target.fn, el, props, rendered, `${chain}${path.relative(site, src.file)}:${el.line} → `, depth + 1);
    }
  };

  for (const file of files) {
    const src = load(file, site);
    for (const decl of new Set(src.declarations.values())) {
      const fn = componentFn(decl);
      if (fn) visit(src, fn, null, new Map(), new Set(), '', 0);
    }
  }
  return (module, a, b) => siblings.has(pairKey(module, a, b)) && !together.has(pairKey(module, a, b));
}
