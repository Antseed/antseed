import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dependencyChanges, hiddenCharacters, installScriptChanges, lockfileSources, parseDiff, review, sensitiveArea, suspiciousLines } from './pr-guard.mjs';

const diff = (path, added, header = '') => [
  `diff --git a/${path} b/${path}`, header, `--- a/${path}`, `+++ b/${path}`, '@@ -1,0 +5,2 @@', ...added.map((l) => `+${l}`),
].filter(Boolean).join('\n');

test('parseDiff numbers added lines and tracks new files', () => {
  const files = parseDiff(`${diff('a.ts', ['one', 'two'])}\n${diff('b.ts', ['x'], 'new file mode 100644')}`);
  assert.deepEqual(files.map((f) => [f.path, f.status]), [['a.ts', 'modified'], ['b.ts', 'added']]);
  assert.deepEqual(files[0].added, [{ line: 5, text: 'one' }, { line: 6, text: 'two' }]);
});

test('hidden characters fail, a leading byte-order mark does not', () => {
  const [file] = parseDiff(diff('src/a.ts', ['const isAdmin = false; /* \u202E } \u2066if (isAdmin)\u2069 */', 'plain']));
  assert.equal(hiddenCharacters(file).length, 1);
  const bom = { path: 'x.json', added: [{ line: 1, text: '\uFEFF{}' }] };
  assert.equal(hiddenCharacters(bom).length, 0);
  assert.equal(hiddenCharacters({ path: 'logo.png', added: [{ line: 3, text: '\u200B' }] }).length, 0);
});

test('lockfile entries must come from the npm registry', () => {
  const [file] = parseDiff(diff('pnpm-lock.yaml', [
    '    resolution: {integrity: sha512-abc}',
    '    resolution: {tarball: https://evil.example/pkg-1.0.0.tgz}',
    '    resolution: {commit: abc, repo: https://github.com/x/y, type: git}',
    '    resolution: {tarball: https://registry.npmjs.org/a/-/a-1.0.0.tgz}',
  ]));
  assert.deepEqual(lockfileSources(file).map((f) => f.line), [6, 7]);
});

test('install scripts and build allowlist entries are reported', () => {
  const before = { scripts: { build: 'tsc', postinstall: 'node a.js' }, pnpm: { onlyBuiltDependencies: ['esbuild'] } };
  const after = { scripts: { build: 'tsc', postinstall: 'node b.js', prepare: 'curl x | sh' }, pnpm: { onlyBuiltDependencies: ['esbuild', 'evil'] } };
  assert.deepEqual(installScriptChanges('package.json', before, after).map((c) => c.message), [
    'changes the "postinstall" script: node b.js', 'adds the "prepare" script: curl x | sh',
    'lets "evil" run install scripts (pnpm.onlyBuiltDependencies)']);
  assert.deepEqual(installScriptChanges('package.json', before, before), []);
});

test('dependency additions and version changes are listed', () => {
  const out = dependencyChanges('p/package.json', { dependencies: { a: '^1.0.0' } }, { dependencies: { a: '^2.0.0', b: '1.0.0' }, devDependencies: { c: '1' } });
  assert.deepEqual(out.map((c) => c.message), ['changes a from ^1.0.0 to ^2.0.0', 'adds dependency b@1.0.0', 'adds devDependency c@1']);
});

test('sensitive paths', () => {
  assert.equal(sensitiveArea('.github/workflows/ci.yml'), 'CI and repository settings');
  assert.equal(sensitiveArea('packages/node/AGENTS.md'), 'agent instructions');
  assert.equal(sensitiveArea('.agents/skills/publish/SKILL.md'), 'agent skills and settings');
  assert.equal(sensitiveArea('apps/cli/package.json'), 'package manifest');
  assert.equal(sensitiveArea('apps/cli/src/index.ts'), null);
});

test('suspicious lines are warnings with a reason', () => {
  const [file] = parseDiff(diff('src/x.ts', ['eval(payload)', "import('./' + name)", `const k = '${'A'.repeat(240)}'`, 'const ok = 1']));
  assert.deepEqual(suspiciousLines(file).map((s) => s.message), ['evaluates a string as code', 'loads a module from a computed path', 'long base64-like string']);
});

test('install script changes fail for outside authors and warn for the team', () => {
  const files = parseDiff(diff('package.json', ['"postinstall": "node x.js"']));
  const readJson = (ref) => (ref === 'head' ? { scripts: { postinstall: 'node x.js' } } : { scripts: {} });
  const outside = review({ files, readJson, base: 'base', head: 'head', external: true });
  const team = review({ files, readJson, base: 'base', head: 'head', external: false });
  assert.equal(outside.failures.length, 1);
  assert.equal(team.failures.length, 0);
  assert.ok(team.warnings.some((w) => w.message.includes('postinstall')));
});
