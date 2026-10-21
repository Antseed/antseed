/**
 * Shallow renderer with working hooks, for interaction tests without a DOM.
 *
 * Renders one function component (child components stay unrendered elements
 * whose props can be inspected and whose callbacks can be called), keeps its
 * hook state across renders, runs effects after each render and re-renders
 * synchronously on every state update. Hooks are served by installing a
 * dispatcher on React's shared internals for the duration of each render, the
 * way react-shallow-renderer does.
 */
import * as React from 'react';
import type { ReactElement, ReactNode } from 'react';

type Deps = readonly unknown[] | undefined;
type EffectCleanup = (() => void) | void;
type Hook =
  | { kind: 'state'; value: unknown; set: (next: unknown) => void }
  | { kind: 'effect'; deps: Deps; create?: () => EffectCleanup; cleanup?: EffectCleanup }
  | { kind: 'memo'; deps: Deps; value: unknown }
  | { kind: 'ref'; value: { current: unknown } };

type Internals = { H: unknown };
const internals = (React as unknown as Record<string, Internals>)
  .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;

const MAX_RENDERS = 50;

function depsChanged(previous: Deps, next: Deps): boolean {
  if (!previous || !next || previous.length !== next.length) return true;
  return next.some((dep, index) => !Object.is(dep, previous[index]));
}

export type AnyElement = ReactElement<Record<string, unknown>>;

/** Text content of a node, through nested elements' children. */
export function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (React.isValidElement(node)) return textOf((node as AnyElement).props.children);
  return '';
}

function collect(node: unknown, out: AnyElement[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return;
  }
  if (!React.isValidElement(node)) return;
  const element = node as AnyElement;
  out.push(element);
  // Children and element-valued props (e.g. a setting row's `control`).
  for (const value of Object.values(element.props)) collect(value, out);
}

export type ShallowRender = {
  /** What the component returned on its latest render. */
  readonly root: ReactNode;
  /** Every element in the latest output, children and element-valued props included. */
  findAll(predicate: (element: AnyElement) => boolean): AnyElement[];
  /** The first clickable element whose text contains `label`; throws when missing. */
  button(label: string): AnyElement;
  /** Whether an element with an onClick and this label is present. */
  hasButton(label: string): boolean;
  /** Render again with a new element's props, keeping hook state (a parent re-render). */
  rerender(element: ReactElement): void;
  unmount(): void;
};

export function shallowRender(element: ReactElement): ShallowRender {
  const component = element.type;
  if (typeof component !== 'function') throw new Error('shallowRender expects a function component element');
  const render = component as (props: unknown) => ReactNode;
  let props = element.props;

  const hooks: Hook[] = [];
  let cursor = 0;
  let root: ReactNode = null;
  let dirty = false;
  let rendering = false;
  let mounted = true;

  const next = <K extends Hook['kind']>(kind: K, init: () => Extract<Hook, { kind: K }>): Extract<Hook, { kind: K }> => {
    const index = cursor++;
    const hook = hooks[index] ?? (hooks[index] = init());
    if (hook.kind !== kind) throw new Error(`Hook order changed at ${index}: ${hook.kind} → ${kind}`);
    return hook as Extract<Hook, { kind: K }>;
  };

  const schedule = () => {
    dirty = true;
    if (mounted && !rendering) flush();
  };

  const useMemo = (factory: () => unknown, deps: Deps) => {
    const hook = next('memo', () => ({ kind: 'memo', deps: undefined, value: undefined }));
    if (depsChanged(hook.deps, deps)) {
      hook.value = factory();
      hook.deps = deps;
    }
    return hook.value;
  };
  const useEffect = (create: () => EffectCleanup, deps: Deps) => {
    const hook = next('effect', () => ({ kind: 'effect', deps: undefined }));
    if (depsChanged(hook.deps, deps)) {
      hook.create = create;
      hook.deps = deps;
    }
  };

  const dispatcher = {
    useState(initial: unknown) {
      const hook = next('state', () => {
        const state: Extract<Hook, { kind: 'state' }> = {
          kind: 'state',
          value: typeof initial === 'function' ? (initial as () => unknown)() : initial,
          set: (update: unknown) => {
            const value = typeof update === 'function' ? (update as (previous: unknown) => unknown)(state.value) : update;
            if (Object.is(value, state.value)) return;
            state.value = value;
            schedule();
          },
        };
        return state;
      });
      return [hook.value, hook.set];
    },
    useEffect,
    useLayoutEffect: useEffect,
    useInsertionEffect: useEffect,
    useMemo,
    useCallback: (callback: unknown, deps: Deps) => useMemo(() => callback, deps),
    useRef: (initial: unknown) => next('ref', () => ({ kind: 'ref', value: { current: initial } })).value,
    useContext: (context: { _currentValue: unknown }) => context._currentValue,
    useId: () => next('ref', () => ({ kind: 'ref', value: { current: `:s${cursor}:` } })).value.current,
    useDebugValue: () => undefined,
  };

  function flush(): void {
    rendering = true;
    try {
      let renders = 0;
      do {
        if (++renders > MAX_RENDERS) throw new Error('Too many re-renders');
        dirty = false;
        cursor = 0;
        const previous = internals.H;
        internals.H = dispatcher;
        try {
          root = render(props);
        } finally {
          internals.H = previous;
        }
        for (const hook of hooks) {
          if (hook.kind !== 'effect' || !hook.create) continue;
          const create = hook.create;
          hook.create = undefined;
          if (typeof hook.cleanup === 'function') hook.cleanup();
          hook.cleanup = create();
        }
      } while (dirty && mounted);
    } finally {
      rendering = false;
    }
  }

  flush();

  const findAll = (predicate: (element: AnyElement) => boolean) => {
    const all: AnyElement[] = [];
    collect(root, all);
    return all.filter(predicate);
  };
  const clickable = (label: string) => findAll((el) => typeof el.props.onClick === 'function' && textOf(el.props.children).includes(label));

  return {
    get root() { return root; },
    findAll,
    button(label) {
      const [match] = clickable(label);
      if (!match) throw new Error(`No button labelled "${label}"`);
      return match;
    },
    hasButton: (label) => clickable(label).length > 0,
    rerender(next) {
      if (next.type !== component) throw new Error('rerender expects the same component');
      props = next.props;
      flush();
    },
    unmount() {
      mounted = false;
      for (const hook of hooks) {
        if (hook.kind === 'effect' && typeof hook.cleanup === 'function') hook.cleanup();
      }
    },
  };
}
