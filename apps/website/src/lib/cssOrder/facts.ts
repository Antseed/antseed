import type * as t from '@babel/types';

/** A literal a prop can hold; `null` stands for an absent prop. */
export type Literal = string | number | boolean | null;
/** What a condition says about one variable: its value, values it isn't, or only whether it is truthy. */
type Fact = {value?: Literal; hasValue?: boolean; not?: readonly Literal[]; truthy?: boolean};
export type Facts = ReadonlyMap<string, Fact>;

export const NO_FACTS: Facts = new Map();

function combine(a: Fact, b: Fact): Fact | null {
  if (a.hasValue && b.hasValue && a.value !== b.value) return null;
  if (a.truthy !== undefined && b.truthy !== undefined && a.truthy !== b.truthy) return null;
  const out: Fact = {
    value: a.hasValue ? a.value : b.value,
    hasValue: a.hasValue || b.hasValue,
    not: [...(a.not ?? []), ...(b.not ?? [])],
    truthy: a.truthy ?? b.truthy,
  };
  if (out.hasValue && (out.not!.includes(out.value!) || (out.truthy !== undefined && out.truthy !== Boolean(out.value)))) return null;
  return out;
}

/** Both sets of facts at once, or null when they contradict each other. */
export function merge(a: Facts, b: Facts): Facts | null {
  if (!a.size) return b;
  if (!b.size) return a;
  const out = new Map(a);
  for (const [key, fact] of b) {
    const both = out.has(key) ? combine(out.get(key)!, fact) : fact;
    if (!both) return null;
    out.set(key, both);
  }
  return out;
}

/** `outline.top` → "outline.top"; anything that is not a plain name or a chain of names has no key. */
function keyOf(e: t.Node): string | null {
  if (e.type === 'Identifier') return e.name;
  if (e.type === 'MemberExpression' && !e.computed && e.property.type === 'Identifier') {
    const object = keyOf(e.object);
    return object && `${object}.${e.property.name}`;
  }
  return null;
}

export function literalOf(e: t.Node): Literal | undefined {
  if (e.type === 'StringLiteral' || e.type === 'NumericLiteral' || e.type === 'BooleanLiteral') return e.value;
  if (e.type === 'NullLiteral' || (e.type === 'Identifier' && e.name === 'undefined')) return null;
  return undefined;
}

const fact = (key: string, f: Fact): Facts[] => [new Map([[key, f]])];
const both = (a: Facts[], b: Facts[]) => a.flatMap((x) => b.map((y) => merge(x, y))).filter((f): f is Facts => f !== null);

/** The alternative sets of facts under which `test` is `want` (truthy or falsy). Unknown tests hold under no facts. */
export function conditionsOf(test: t.Node, want: boolean): Facts[] {
  switch (test.type) {
    case 'TSAsExpression': case 'TSNonNullExpression': case 'ParenthesizedExpression':
      return conditionsOf(test.expression, want);
    case 'UnaryExpression':
      return test.operator === '!' ? conditionsOf(test.argument, !want) : [NO_FACTS];
    case 'BooleanLiteral':
      return test.value === want ? [NO_FACTS] : [];
    case 'BinaryExpression': {
      if (!['===', '!==', '==', '!='].includes(test.operator)) return [NO_FACTS];
      const [key, literal] = keyOf(test.left) ? [keyOf(test.left), literalOf(test.right)] : [keyOf(test.right), literalOf(test.left)];
      if (!key || literal === undefined) return [NO_FACTS];
      const equal = test.operator.startsWith('=') === want;
      return fact(key, equal ? {value: literal, hasValue: true} : {not: [literal]});
    }
    case 'LogicalExpression': {
      const [l, r] = [test.left, test.right];
      if (test.operator === '&&') return want ? both(conditionsOf(l, true), conditionsOf(r, true)) : [...conditionsOf(l, false), ...both(conditionsOf(l, true), conditionsOf(r, false))];
      if (test.operator === '||') return want ? [...conditionsOf(l, true), ...both(conditionsOf(l, false), conditionsOf(r, true))] : both(conditionsOf(l, false), conditionsOf(r, false));
      return [NO_FACTS];
    }
    default: {
      const key = keyOf(test);
      return key ? fact(key, {truthy: want}) : [NO_FACTS];
    }
  }
}

/** A prop's value at a call site: a literal, or absent (`null`). */
export const valueFact = (key: string, value: Literal): Facts => new Map([[key, {value, hasValue: true}]]);
