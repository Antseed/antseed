#!/usr/bin/env node
// pr-guard: the mechanical part of checking a pull request for a supply-chain attack. It reads only the git diff
// between the base branch and the PR head; it runs nothing from the PR and needs no secrets.
//
// It FAILS on what is never needed in this repo:
//   - bidirectional or zero-width Unicode characters added to a text file (they make code read differently from
//     how it runs);
//   - a lockfile package that resolves outside registry.npmjs.org (a tarball URL or a git dependency);
//   - an install-time script (preinstall, install, postinstall, prepare) added or changed in a package.json, or a
//     new entry in pnpm.onlyBuiltDependencies, from an author outside the team.
// It WARNS, for a maintainer to read, on changes to sensitive paths (CI, agent instructions, install and build
// tooling, contracts, dependencies) and on added lines that look like hidden behavior (eval, child_process,
// long encoded strings). A warning is not a verdict: it says where to look.
//
// Usage: node scripts/pr-guard.mjs --base <ref> [--head HEAD] [--author-association MEMBER]
// CI runs the copy on the base branch, so a PR cannot weaken the check that reviews it.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const TEAM_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];
// U+202A-U+202E and U+2066-U+2069 reorder text; U+200B-U+200D, U+2060 and U+FEFF are invisible.
const HIDDEN_CHARS = /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF]/u;
const ALLOWED_REGISTRY = 'https://registry.npmjs.org/';
const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|webp|ico|icns|pdf|woff2?|ttf|otf|mp4|mov|webm|wasm|zip|gz|tgz|node|dylib|so|dll|exe|bin)$/i;

const SENSITIVE = [
  [/^\.github\//, 'CI and repository settings'],
  [/(^|\/)(AGENTS|CLAUDE)\.md$/, 'agent instructions'],
  [/^\.(agents|claude|codex)\//, 'agent skills and settings'],
  [/(^|\/)CODEOWNERS$/, 'code owners'],
  [/(^|\/)package\.json$/, 'package manifest'],
  [/^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$|(^|\/)\.npmrc$|^patches\//, 'dependency resolution'],
  [/^scripts\/|(^|\/)Dockerfile[^/]*$|^flake\.(nix|lock)$|(^|\/)(vite|vitest|tsup|esbuild|electron-builder)\.config\.[cm]?[jt]s$/, 'build and release tooling'],
  [/^packages\/contracts\//, 'smart contracts'],
];

const SUSPICIOUS = [
  [/\beval\s*\(|\bnew\s+Function\s*\(/, 'evaluates a string as code'],
  [/\bchild_process\b|\bexecSync\s*\(|\bspawnSync?\s*\(/, 'starts a process'],
  // anything but one plain string literal (a template literal with ${...} counts as computed)
  [/\b(?:require|import)\s*\(\s*(?!(['"])[^'"]*\1\s*[),])(?!`[^`$]*`\s*[),])(?=\S)(?!\))/, 'loads a module from a computed path'],
  [/[A-Za-z0-9+/]{200,}={0,2}/, 'long base64-like string'],
  [/(?:\\x[0-9a-fA-F]{2}){16,}|(?:\\u[0-9a-fA-F]{4}){12,}/, 'long escaped byte sequence'],
  [/\batob\s*\(|Buffer\.from\([^)]*['"]base64['"]/, 'decodes base64'],
  [/https?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\//, 'calls a raw IP address'],
  [/\.(ssh|aws|antseed)\/|id_rsa|keychain|wallet\.json|PRIVATE_KEY/, 'reads keys, wallets or credentials'],
];

// --- pure checks (exported for tests) -----------------------------------------------------------------------------

/** Files and added lines from `git diff --unified=0` output: [{ path, status, added: [{ line, text }] }]. */
export function parseDiff(diff) {
  const files = [];
  let file = null;
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const match = raw.match(/ b\/(.+)$/);
      file = { path: match ? match[1] : '', status: 'modified', added: [] };
      files.push(file);
    } else if (!file) {
      continue;
    } else if (raw.startsWith('new file mode')) {
      file.status = 'added';
    } else if (raw.startsWith('deleted file mode')) {
      file.status = 'deleted';
    } else if (raw.startsWith('+++ ')) {
      if (raw !== '+++ /dev/null') file.path = raw.slice(6);
    } else if (raw.startsWith('@@')) {
      line = Number(raw.match(/\+(\d+)/)?.[1] ?? 0);
    } else if (raw.startsWith('+')) {
      file.added.push({ line, text: raw.slice(1) });
      line += 1;
    }
  }
  return files;
}

export function hiddenCharacters(file) {
  if (BINARY_EXTENSIONS.test(file.path)) return [];
  return file.added.filter(({ text, line }) => HIDDEN_CHARS.test(line === 1 ? text.replace(/^\uFEFF/, '') : text))
    .map(({ line }) => ({ path: file.path, line, message: 'adds a bidirectional or zero-width Unicode character' }));
}

export function lockfileSources(file) {
  if (file.path !== 'pnpm-lock.yaml') return [];
  const out = [];
  for (const { text, line } of file.added) {
    const tarball = text.match(/tarball:\s*([^\s,}]+)/);
    if (tarball && !tarball[1].startsWith(ALLOWED_REGISTRY)) out.push({ path: file.path, line, message: `resolves a package from ${tarball[1]}` });
    if (/type:\s*git\b|\bcodeload\.github\.com|git\+(ssh|https?):/.test(text)) out.push({ path: file.path, line, message: 'resolves a package from a git repository' });
  }
  return out;
}

/** Install-time scripts and build allowlist entries a package.json change adds or alters. */
export function installScriptChanges(path, before, after) {
  const out = [];
  const scripts = (pkg) => (pkg && pkg.scripts) || {};
  for (const name of INSTALL_SCRIPTS) {
    const old = scripts(before)[name];
    const now = scripts(after)[name];
    if (now !== undefined && now !== old) out.push({ path, message: `${old === undefined ? 'adds' : 'changes'} the "${name}" script: ${now}` });
  }
  const allowed = (pkg) => new Set((pkg && pkg.pnpm && pkg.pnpm.onlyBuiltDependencies) || []);
  const had = allowed(before);
  for (const name of allowed(after)) if (!had.has(name)) out.push({ path, message: `lets "${name}" run install scripts (pnpm.onlyBuiltDependencies)` });
  return out;
}

/** Dependency names a package.json change adds, or whose version spec changes. */
export function dependencyChanges(path, before, after) {
  const out = [];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const old = (before && before[field]) || {};
    for (const [name, spec] of Object.entries((after && after[field]) || {})) {
      if (old[name] === undefined) out.push({ path, message: `adds ${field.replace('ies', 'y')} ${name}@${spec}` });
      else if (old[name] !== spec) out.push({ path, message: `changes ${name} from ${old[name]} to ${spec}` });
    }
  }
  return out;
}

export function sensitiveArea(path) {
  return SENSITIVE.find(([pattern]) => pattern.test(path))?.[1] ?? null;
}

export function suspiciousLines(file) {
  if (BINARY_EXTENSIONS.test(file.path) || /(^|\/)(pnpm-lock\.yaml|package-lock\.json)$|\.(svg|map|snap|lock)$/.test(file.path)) return [];
  const out = [];
  for (const { text, line } of file.added) {
    for (const [pattern, why] of SUSPICIOUS) {
      if (pattern.test(text)) out.push({ path: file.path, line, message: why });
    }
  }
  return out;
}

/** Everything the guard reports for one PR: { failures, warnings }. `readJson(ref, path)` reads a file at a ref. */
export function review({ files, readJson, base, head, external }) {
  const failures = [];
  const warnings = [];
  for (const file of files) {
    if (file.status === 'deleted') continue;
    failures.push(...hiddenCharacters(file), ...lockfileSources(file));
    if (/(^|\/)package\.json$/.test(file.path)) {
      const before = file.status === 'added' ? null : readJson(base, file.path);
      const after = readJson(head, file.path);
      (external ? failures : warnings).push(...installScriptChanges(file.path, before, after));
      warnings.push(...dependencyChanges(file.path, before, after));
    }
    const area = sensitiveArea(file.path);
    if (area) warnings.push({ path: file.path, message: `changes ${area}` });
    warnings.push(...suspiciousLines(file));
  }
  return { failures, warnings };
}

export function summary({ failures, warnings }, external) {
  const lines = ['## pr-guard', '', external
    ? 'The author is outside the team: a maintainer reads every warning below before this PR merges.'
    : 'The author is on the team.'];
  const list = (items) => items.map((i) => `- \`${i.path}${i.line ? `:${i.line}` : ''}\` ${i.message}`);
  lines.push('', failures.length ? `### Failed (${failures.length})` : '### No failures', ...list(failures));
  lines.push('', warnings.length ? `### Look here (${warnings.length})` : '### Nothing to look at', ...list(warnings.slice(0, 200)));
  if (warnings.length > 200) lines.push(`- ...and ${warnings.length - 200} more`);
  return lines.join('\n');
}

// --- command line -------------------------------------------------------------------------------------------------

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function main() {
  const base = arg('base');
  const head = arg('head', 'HEAD');
  if (!base) {
    console.error('usage: pr-guard.mjs --base <ref> [--head HEAD] [--author-association MEMBER]');
    process.exit(2);
  }
  const association = String(arg('author-association', '')).toUpperCase();
  const external = !TEAM_ASSOCIATIONS.has(association);
  const mergeBase = git('merge-base', base, head).trim();
  const files = parseDiff(git('diff', '--unified=0', '--no-color', '--no-ext-diff', '--find-renames', mergeBase, head));
  const readJson = (ref, path) => {
    try { return JSON.parse(git('show', `${ref}:${path}`)); } catch { return null; }
  };
  const result = review({ files, readJson, base: mergeBase, head, external });
  for (const f of result.failures) console.log(`::error file=${f.path}${f.line ? `,line=${f.line}` : ''}::${f.message}`);
  for (const w of result.warnings) console.log(`::warning file=${w.path}${w.line ? `,line=${w.line}` : ''}::${w.message}`);
  const text = summary(result, external);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  else console.log(text);
  process.exit(result.failures.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
