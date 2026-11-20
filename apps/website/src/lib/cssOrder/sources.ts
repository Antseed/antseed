import fs from 'node:fs';
import path from 'node:path';
import {parse} from '@babel/parser';
import type * as t from '@babel/types';

/* Reading the site's TSX: what each file imports, declares and exports, and which component a JSX tag names. */

export type Fn = t.Function;
export type SourceFile = {
  file: string;
  /** The CSS module's import name (`styles`) and its file. */
  styles: string | null;
  stylesFile: string | null;
  /** Top-level declarations by name (functions and `const` initializers); `default` is the default export. */
  declarations: Map<string, t.Node>;
  imports: Map<string, {file: string; name: string}>;
  reexports: Map<string, {file: string; name: string}>;
};

const cache = new Map<string, SourceFile>();

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'typeAnnotation', 'returnType']);


export const isNode = (v: unknown): v is t.Node => typeof (v as t.Node | null)?.type === 'string';
const children = (n: t.Node): t.Node[] =>
  Object.entries(n).flatMap(([k, v]) => (SKIP_KEYS.has(k) ? [] : Array.isArray(v) ? v : [v])).filter(isNode);

export function walk(n: t.Node, visit: (n: t.Node) => boolean | void): void {
  if (visit(n) === false) return;
  for (const c of children(n)) walk(c, visit);
}

function resolveSource(spec: string, from: string, site: string): string | null {
  const base = spec.startsWith('.') ? path.resolve(path.dirname(from), spec)
    : spec.startsWith('@site/') ? path.join(site, spec.slice(6))
    : spec.startsWith('@theme/') ? path.join(site, 'src/theme', spec.slice(7))
    : null;
  if (!base) return null;
  for (const candidate of ['', '.tsx', '.ts', '/index.tsx', '/index.ts'].map((ext) => base + ext)) {
    if (/\.tsx?$/.test(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export const nameOf = (n: t.Node) => (n.type === 'Identifier' || n.type === 'JSXIdentifier' ? n.name : n.type === 'StringLiteral' ? n.value : '');

function declare(info: SourceFile, d: t.Node | null | undefined, isDefault = false) {
  if (!d) return;
  if (d.type === 'FunctionDeclaration' && d.id) info.declarations.set(d.id.name, d);
  if (d.type === 'VariableDeclaration') for (const v of d.declarations) if (v.id.type === 'Identifier' && v.init) info.declarations.set(v.id.name, v.init);
  if (isDefault) info.declarations.set('default', d.type === 'Identifier' ? info.declarations.get(d.name) ?? d : d);
}

export function load(file: string, site: string): SourceFile {
  const cached = cache.get(file);
  if (cached) return cached;
  const ast = parse(fs.readFileSync(file, 'utf8'), {sourceType: 'module', plugins: ['typescript', 'jsx']});
  const info: SourceFile = {file, styles: null, stylesFile: null, declarations: new Map(), imports: new Map(), reexports: new Map()};
  cache.set(file, info);
  for (const st of ast.program.body) {
    if (st.type === 'ImportDeclaration' && st.importKind !== 'type') {
      const spec = st.source.value;
      if (spec.endsWith('.module.css')) {
        info.styles = st.specifiers.find((s) => s.type === 'ImportDefaultSpecifier')?.local.name ?? null;
        info.stylesFile = path.resolve(path.dirname(file), spec);
        continue;
      }
      const target = resolveSource(spec, file, site);
      if (!target) continue;
      for (const s of st.specifiers) {
        if (s.type === 'ImportDefaultSpecifier') info.imports.set(s.local.name, {file: target, name: 'default'});
        if (s.type === 'ImportSpecifier' && s.importKind !== 'type') info.imports.set(s.local.name, {file: target, name: nameOf(s.imported)});
      }
    } else if (st.type === 'ExportNamedDeclaration') {
      declare(info, st.declaration);
      const target = st.source ? resolveSource(st.source.value, file, site) : null;
      if (target) for (const s of st.specifiers) if (s.type === 'ExportSpecifier') info.reexports.set(nameOf(s.exported), {file: target, name: s.local.name});
    } else if (st.type === 'ExportDefaultDeclaration') {
      declare(info, st.declaration, true);
    } else {
      declare(info, st);
    }
  }
  return info;
}

export const isFunction = (n: t.Node | undefined): n is Fn =>
  !!n && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');
/** A component: a function, or a call wrapping one (`memo(…)`, `forwardRef(…)`). */
export function componentFn(n: t.Node | undefined): Fn | null {
  if (isFunction(n)) return n;
  if (n?.type === 'CallExpression') for (const a of n.arguments) if (isFunction(a)) return a;
  return null;
}

/** The component `name` exported from `file`, following re-exports. */
function findComponent(file: string, name: string, site: string, hops = 0): {src: SourceFile; fn: Fn} | null {
  const src = load(file, site);
  const fn = componentFn(src.declarations.get(name));
  if (fn) return {src, fn};
  const re = src.reexports.get(name);
  return re && hops < 5 ? findComponent(re.file, re.name, site, hops + 1) : null;
}

export function resolveTag(src: SourceFile, tag: string, site: string): {src: SourceFile; fn: Fn} | null {
  const imp = src.imports.get(tag);
  if (imp) return findComponent(imp.file, imp.name, site);
  const fn = componentFn(src.declarations.get(tag));
  return fn ? {src, fn} : null;
}
