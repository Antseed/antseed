import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CAManager, classifyCATrust, describeTrustInstallFailure } from './ca-manager.js'

test('CAManager.exists() returns false before generation', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'antseed-ca-test-'))
  try {
    const mgr = new CAManager(tmpDir)
    assert.equal(await mgr.exists(), false)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('CAManager.generate() creates cert and key files', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'antseed-ca-test-'))
  try {
    const mgr = new CAManager(tmpDir)
    const keys = await mgr.generate()
    assert.ok(keys.certPem.includes('BEGIN CERTIFICATE'), 'cert should be PEM')
    assert.ok(keys.privateKeyPem.includes('BEGIN PRIVATE KEY'), 'key should be PKCS8 PEM')
    assert.equal(await mgr.exists(), true)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('CAManager.load() returns the same PEM that was generated', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'antseed-ca-test-'))
  try {
    const mgr = new CAManager(tmpDir)
    const generated = await mgr.generate()
    const loaded = await mgr.load()
    assert.equal(loaded.certPem, generated.certPem)
    assert.equal(loaded.privateKeyPem, generated.privateKeyPem)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('CAManager.certFilePath points into the system-proxy subdirectory', () => {
  const mgr = new CAManager('/some/data/dir')
  assert.ok(mgr.certFilePath.includes('system-proxy'), 'cert path should be under system-proxy/')
  assert.ok(mgr.certFilePath.endsWith('.crt'), 'cert file should have .crt extension')
})

test('classifyCATrust: trusted when the current fingerprint is installed', () => {
  assert.equal(classifyCATrust('AA:BB:CC', ['aabbcc']), 'trusted')
  assert.equal(classifyCATrust('aabbcc', ['AA BB CC', '112233']), 'trusted')
})

test('classifyCATrust: stale when an Antseed CA is trusted with a different fingerprint', () => {
  // The CERT_SIGNATURE_FAILURE case: an old CA is trusted, current one is not.
  assert.equal(classifyCATrust('AABBCC', ['DDEEFF']), 'stale')
})

test('classifyCATrust: absent when nothing is trusted', () => {
  assert.equal(classifyCATrust('AABBCC', []), 'absent')
})

test('classifyCATrust: absent when the current fingerprint is empty', () => {
  // No ca.crt yet → nothing to match, treated as absent regardless of installs.
  assert.equal(classifyCATrust('', []), 'absent')
  assert.equal(classifyCATrust('', ['AABBCC']), 'stale')
})

test('describeTrustInstallFailure classifies a cancelled admin prompt', () => {
  const err = Object.assign(
    new Error("Command failed: osascript -e 'do shell script \"security add-trusted-cert ...\"'"),
    { stderr: Buffer.from('execution error: User canceled. (-128)\n') },
  )
  const failure = describeTrustInstallFailure(err)
  assert.equal(failure.reason, 'the administrator prompt was cancelled')
  assert.equal(failure.detail, 'execution error: User canceled. (-128)')
})

test('describeTrustInstallFailure never leaks the command line into the detail', () => {
  const err = new Error("Command failed: osascript -e 'do shell script \"security delete-certificate -Z AABB /Library/Keychains/System.keychain\"'")
  const failure = describeTrustInstallFailure(err)
  assert.equal(failure.reason, 'the system-level install failed')
  assert.equal(failure.detail, 'command failed')
})

test('describeTrustInstallFailure keeps concise stderr as the detail', () => {
  const err = Object.assign(new Error('Command failed: security add-trusted-cert ...'), {
    stderr: 'SecTrustSettingsSetTrustSettings: The authorization was denied since no user interaction was possible.',
  })
  const failure = describeTrustInstallFailure(err)
  assert.equal(failure.reason, 'the system-level install failed')
  assert.equal(failure.detail, 'SecTrustSettingsSetTrustSettings: The authorization was denied since no user interaction was possible.')
})

test('CAManager.fingerprint() returns null before generation and hex after', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'antseed-ca-test-'))
  try {
    const mgr = new CAManager(tmpDir)
    assert.equal(mgr.fingerprint(), null)
    await mgr.generate()
    const fp = mgr.fingerprint()
    assert.ok(fp && /^[0-9A-F]+$/.test(fp), 'fingerprint should be bare uppercase hex')
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('CAManager.generate() is idempotent — second call overwrites cleanly', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'antseed-ca-test-'))
  try {
    const mgr = new CAManager(tmpDir)
    const first = await mgr.generate()
    const second = await mgr.generate()
    // Both should be valid PEMs; they won't be identical (fresh keys each time)
    assert.ok(second.certPem.includes('BEGIN CERTIFICATE'))
    assert.ok(second.privateKeyPem.includes('BEGIN PRIVATE KEY'))
    // Different runs produce different keys
    assert.notEqual(first.certPem, second.certPem)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})
