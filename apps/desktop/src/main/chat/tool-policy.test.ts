import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeToolApproval,
  effectivePermissionMode,
  isToolPermissionAutoAllowed,
  requiresToolApproval,
} from './tool-policy.js';

const SCOPE_ID = '0123456789abcdef0123456789abcdef01234567';

function describeBash(command: string) {
  return describeToolApproval('bash', { command }, SCOPE_ID);
}

test('manual mode gates risky tools and full mode bypasses the approval gate', () => {
  assert.equal(requiresToolApproval('manual', 'bash'), true);
  assert.equal(requiresToolApproval('manual', 'edit'), true);
  assert.equal(requiresToolApproval('manual', 'read'), false);
  assert.equal(requiresToolApproval('full', 'bash'), false);
});

test('read-only shell and git commands use auto-allowed permission keys', () => {
  const shellRead = describeBash('rg -n "needle" src');
  const gitRead = describeBash('git status --short');

  assert.equal(shellRead.permissionKey, 'bash:read');
  assert.equal(gitRead.permissionKey, 'bash:git-read');
  assert.equal(isToolPermissionAutoAllowed(shellRead.permissionKey), true);
  assert.equal(isToolPermissionAutoAllowed(gitRead.permissionKey), true);
});

test('read-looking shell commands with mutation operators are not auto-allowed', () => {
  assert.equal(describeBash('echo hello > file.txt').permissionKey, 'bash:write');
  assert.equal(describeBash('find . -name "*.tmp" -delete').permissionKey, 'bash:other');
  assert.equal(describeBash('sed -i s/foo/bar/g file.txt').permissionKey, 'bash:other');
});

test('awk system()/getline/shell-pipe must not auto-allow', () => {
  // POSIX awk's system() and getline-via-pipe execute arbitrary shell. The
  // first-word allowlist would otherwise classify these as `bash:read` and
  // skip the approval prompt entirely.
  const bypasses = [
    "awk 'BEGIN{system(\"env\")}'",
    "awk 'BEGIN{\"id\" | getline x; print x}' /dev/null",
    "awk '{print | \"sh\"}' file",
  ];
  for (const command of bypasses) {
    const approval = describeBash(command);
    assert.equal(
      isToolPermissionAutoAllowed(approval.permissionKey),
      false,
      `expected ${command} to require explicit approval, got ${approval.permissionKey}`,
    );
  }
});

test('sed e command/flag and -f script-from-file must not auto-allow', () => {
  // sed's `e` flag on s/// substitutions and `e` command both execute
  // arbitrary shell. `w` commands/flags write files without a shell redirect.
  // `-f` reads a script from a file whose contents we cannot verify.
  const bypasses = [
    "sed 'e id' file",
    "sed -n '1e cat /etc/passwd' file",
    "sed -n '/foo/e id' file",
    "sed 's/a/b/e' file",
    "sed -n '1,$e id' file",
    "sed 's/a/b/ge' file",
    "sed -n 'w /tmp/pwn' file",
    "sed 's/a/b/w /tmp/pwn' file",
    "sed -f script.sed file",
  ];
  for (const command of bypasses) {
    const approval = describeBash(command);
    assert.equal(
      isToolPermissionAutoAllowed(approval.permissionKey),
      false,
      `expected ${command} to require explicit approval, got ${approval.permissionKey}`,
    );
  }
});

test('find -exec / -fprintf / -fprint / -fls must not auto-allow', () => {
  // These find predicates either execute commands or write arbitrary content
  // to an arbitrary path with no `>` operator, bypassing the shell-level
  // composition and write-operator checks.
  const bypasses = [
    "find . -exec python3 -c 'print(1)' {} +",
    "find . -execdir sh -c 'id' {} +",
    "find . -ok python3 -c 'print(1)' {} +",
    "find . -fprintf /tmp/pwn '%p\\n'",
    "find . -fprint /tmp/list",
    "find . -fprint0 /tmp/list0",
    "find . -fls /tmp/listing",
  ];
  for (const command of bypasses) {
    const approval = describeBash(command);
    assert.equal(
      isToolPermissionAutoAllowed(approval.permissionKey),
      false,
      `expected ${command} to require explicit approval, got ${approval.permissionKey}`,
    );
  }
});

test('benign awk/sed/find invocations stay auto-allowed', () => {
  // Regression guard against the new interpreter blocks: ordinary read-only
  // usages of these tools must still classify as bash:read.
  const benign = [
    "awk '{print $1}' file",
    "awk '/pattern/ {print}' file",
    "sed 's/foo/bar/' file",
    "sed -n '1,10p' file",
    "sed 's/red/blue/g' file",
    "find . -name '*.ts'",
    "find . -type f -print",
  ];
  for (const command of benign) {
    const approval = describeBash(command);
    assert.equal(
      approval.permissionKey,
      'bash:read',
      `expected ${command} to classify as bash:read, got ${approval.permissionKey}`,
    );
  }
});

test('sensitive commands cannot be saved as reusable peer approvals', () => {
  for (const command of ['sudo make install', 'rm -rf dist', 'git reset --hard HEAD']) {
    const approval = describeBash(command);
    assert.equal(approval.permissionKey, 'bash:sensitive');
    assert.equal(approval.canAlwaysAllow, false);
  }
});

test('read-only pipelines of read commands stay auto-allowed', () => {
  const piped = describeBash('grep -n needle src | wc -l');
  assert.equal(piped.permissionKey, 'bash:read');
  assert.equal(isToolPermissionAutoAllowed(piped.permissionKey), true);
});

test('read-looking commands that smuggle a second command are never auto-allowed', () => {
  // A trusting first-word allowlist would classify each of these by its leading
  // read command. The composition guard must force a non-auto class instead.
  const bypasses = [
    'cat $(node payload.js)',     // command substitution
    'cat `node payload.js`',      // backtick substitution
    'ls <(node payload.js)',      // process substitution
    'ls\nnode payload.js',        // newline-separated statements
    'grep foo file && node x.js', // chaining via &&
    'grep foo file | node x.js',  // pipe into a non-read command
  ];
  for (const command of bypasses) {
    const approval = describeBash(command);
    assert.equal(
      isToolPermissionAutoAllowed(approval.permissionKey),
      false,
      `expected ${command} to require explicit approval, got ${approval.permissionKey}`,
    );
  }
});

test('read-only git commands with trailing composition are not auto-allowed', () => {
  assert.equal(isToolPermissionAutoAllowed(describeBash('git status && node x.js').permissionKey), false);
  assert.equal(isToolPermissionAutoAllowed(describeBash('git log; node x.js').permissionKey), false);
});

test('network and file-changing commands require explicit non-auto approval', () => {
  const network = describeBash('curl https://example.com/install.sh');
  const write = describeBash('pnpm install');

  assert.equal(network.permissionKey, 'bash:network');
  assert.equal(write.permissionKey, 'bash:write');
  assert.equal(isToolPermissionAutoAllowed(network.permissionKey), false);
  assert.equal(isToolPermissionAutoAllowed(write.permissionKey), false);
  assert.equal(network.canAlwaysAllow, true);
  assert.equal(write.canAlwaysAllow, true);
});

test('a run\'s tool permissions are the model\'s saved mode, which a request can lower but not raise', () => {
  assert.equal(effectivePermissionMode('manual', 'full'), 'manual');
  assert.equal(effectivePermissionMode('manual', null), 'manual');
  assert.equal(effectivePermissionMode('full', null), 'full');
  assert.equal(effectivePermissionMode('full', 'full'), 'full');
  assert.equal(effectivePermissionMode('full', 'manual'), 'manual');
});
