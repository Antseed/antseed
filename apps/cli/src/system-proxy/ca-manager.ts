import 'reflect-metadata'
import * as x509 from '@peculiar/x509'
import { webcrypto, X509Certificate, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
x509.cryptoProvider.set(webcrypto as any)

const KEY_ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const

/** Subject/issuer common name of the generated CA — must match `generate()`. */
const CA_COMMON_NAME = 'AntSeed Local CA'

export interface CAKeys {
  certPem: string
  privateKeyPem: string
}

export interface CAInstallResult {
  target: 'system-keychain' | 'login-keychain' | 'windows-root' | 'linux-system'
  warning?: string
  /** Raw failure output backing a warning — for logs/CLI output, never UI. */
  detail?: string
}

/**
 * Whether the OS trust store already trusts *this* CA.
 * - `trusted`: the current ca.crt's fingerprint is present in the trust store.
 * - `stale`:   an AntSeed CA is trusted, but with a different fingerprint — the
 *              cause of CERT_SIGNATURE_FAILURE (leaf signed by the current key,
 *              verified against the old key). Re-trusting must purge it first.
 * - `absent`:  no AntSeed CA is trusted (or the cert hasn't been generated).
 */
export type CATrustState = 'trusted' | 'stale' | 'absent'

/** Normalize a certificate fingerprint to bare uppercase hex for comparison. */
function normalizeFingerprint(value: string): string {
  return value.replace(/[^0-9a-fA-F]/g, '').toUpperCase()
}

/**
 * Classify trust from the current CA fingerprint and the fingerprints of every
 * AntSeed CA the OS currently trusts. Pure so it can be unit-tested without a
 * real keychain.
 */
export function classifyCATrust(currentFingerprint: string, installedFingerprints: readonly string[]): CATrustState {
  const current = normalizeFingerprint(currentFingerprint)
  const installed = installedFingerprints.map(normalizeFingerprint).filter((fp) => fp.length > 0)
  if (current && installed.includes(current)) return 'trusted'
  if (installed.length > 0) return 'stale'
  return 'absent'
}

function pemEncode(label: string, der: ArrayBuffer): string {
  const b64 = Buffer.from(der).toString('base64')
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** Escape a value for interpolation inside a single-quoted PowerShell string. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Failure output of a spawned command WITHOUT the command line itself —
    exec errors embed the entire shell invocation in `message`, which reads
    like something went deeply wrong when shown to a user. */
function commandErrorDetail(err: unknown): string {
  if (err instanceof Error) {
    const stderr = (err as Error & { stderr?: Buffer | string }).stderr?.toString().trim()
    if (stderr) return stderr
    const message = err.message.trim()
    return message.startsWith('Command failed:') ? 'command failed' : message
  }
  return String(err)
}

/**
 * Classify a failed privileged trust-store command into a calm, one-phrase
 * reason for the UI, keeping the raw output separate for logs. The common
 * case is the user dismissing the macOS administrator password prompt or the
 * Windows UAC prompt.
 */
export function describeTrustInstallFailure(err: unknown): { reason: string; detail: string } {
  const detail = commandErrorDetail(err)
  if (/user canceled|canceled by the user/i.test(detail) || detail.includes('-128')) {
    return { reason: 'the administrator prompt was cancelled', detail }
  }
  return { reason: 'the system-level install failed', detail }
}

export class CAManager {
  private readonly dir: string

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'system-proxy')
  }

  private get certPath(): string { return join(this.dir, 'ca.crt') }
  private get keyPath(): string { return join(this.dir, 'ca.key') }

  get certFilePath(): string { return this.certPath }

  async exists(): Promise<boolean> {
    return existsSync(this.certPath) && existsSync(this.keyPath)
  }

  async load(): Promise<CAKeys> {
    const [certPem, privateKeyPem] = await Promise.all([
      readFile(this.certPath, 'utf8'),
      readFile(this.keyPath, 'utf8'),
    ])
    return { certPem, privateKeyPem }
  }

  /** SHA-1 fingerprint of the current ca.crt (bare uppercase hex), or null. */
  fingerprint(): string | null {
    if (!existsSync(this.certPath)) return null
    try {
      const cert = new X509Certificate(readFileSync(this.certPath))
      return normalizeFingerprint(cert.fingerprint)
    } catch {
      return null
    }
  }

  /** macOS keychains that may hold a trusted copy of the CA. */
  private macKeychainPaths(): string[] {
    return [
      join(homedir(), 'Library', 'Keychains', 'login.keychain-db'),
      '/Library/Keychains/System.keychain',
    ]
  }

  /** SHA-1 fingerprints of every AntSeed CA the OS trust store currently holds. */
  private listInstalledFingerprints(): string[] {
    const platform = process.platform
    if (platform === 'darwin') {
      const hashes: string[] = []
      for (const keychain of this.macKeychainPaths()) {
        try {
          const out = execFileSync(
            'security',
            ['find-certificate', '-a', '-c', CA_COMMON_NAME, '-Z', keychain],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
          )
          for (const match of out.matchAll(/SHA-1 hash:\s*([0-9A-Fa-f]+)/g)) {
            hashes.push(match[1]!)
          }
        } catch {
          // Keychain absent or no matching certificate — nothing to add.
        }
      }
      return hashes
    }
    if (platform === 'win32') {
      try {
        const out = execFileSync('certutil', ['-store', 'Root', CA_COMMON_NAME], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        return [...out.matchAll(/Cert Hash\(sha1\):\s*([0-9A-Fa-f ]+)/g)].map((m) => m[1]!)
      } catch {
        return []
      }
    }
    // Linux: the CA is installed as a single file; compare its fingerprint.
    try {
      const installed = new X509Certificate(readFileSync('/usr/local/share/ca-certificates/antseed-ca.crt'))
      return [normalizeFingerprint(installed.fingerprint)]
    } catch {
      return []
    }
  }

  /** Whether the OS already trusts this exact CA. */
  trustState(): CATrustState {
    const current = this.fingerprint()
    if (!current) return 'absent'
    return classifyCATrust(current, this.listInstalledFingerprints())
  }

  /**
   * SHA-1 hashes of AntSeed CAs in one macOS keychain whose fingerprint differs
   * from the current ca.crt. These are the certs that cause
   * CERT_SIGNATURE_FAILURE: trusted under the same subject name, but the proxy
   * now signs leaves with a different key.
   */
  private staleMacHashes(keychain: string, current: string): string[] {
    let out = ''
    try {
      out = execFileSync(
        'security',
        ['find-certificate', '-a', '-c', CA_COMMON_NAME, '-Z', keychain],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      )
    } catch {
      return []
    }
    const stale = [...out.matchAll(/SHA-1 hash:\s*([0-9A-Fa-f]+)/g)]
      .map((m) => normalizeFingerprint(m[1]!))
      .filter((fp) => fp && fp !== current)
    return [...new Set(stale)]
  }

  async generate(): Promise<CAKeys> {
    await mkdir(this.dir, { recursive: true })

    const keyPair = await webcrypto.subtle.generateKey(KEY_ALG, true, ['sign', 'verify'])

    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: '01',
      name: 'CN=AntSeed Local CA, O=AntSeed',
      notBefore: new Date(),
      notAfter: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000),
      signingAlgorithm: SIGN_ALG,
      keys: keyPair,
      extensions: [
        new x509.BasicConstraintsExtension(true, undefined, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
          true,
        ),
        await x509.SubjectKeyIdentifierExtension.create(keyPair.publicKey),
      ],
    })

    const certPem = cert.toString('pem')
    const keyDer = await webcrypto.subtle.exportKey('pkcs8', keyPair.privateKey)
    const privateKeyPem = pemEncode('PRIVATE KEY', keyDer)

    await writeFile(this.certPath, certPem, 'utf8')
    await writeFile(this.keyPath, privateKeyPem, { encoding: 'utf8', mode: 0o600 })

    return { certPem, privateKeyPem }
  }

  async installToSystemKeychain(): Promise<CAInstallResult> {
    const platform = process.platform
    if (platform === 'darwin') {
      return this.installMacOS()
    } else if (platform === 'win32') {
      return this.installWindows()
    } else {
      execFileSync('sudo', ['cp', this.certPath, '/usr/local/share/ca-certificates/antseed-ca.crt'], { stdio: 'pipe' })
      execFileSync('sudo', ['update-ca-certificates'], { stdio: 'pipe' })
      return { target: 'linux-system' }
    }
  }

  /**
   * macOS install, designed around ONE password prompt total. Every privileged
   * `security` invocation can raise its own auth dialog, so all admin-domain
   * work — purging stale System-keychain copies AND trusting the current cert
   * (`add-trusted-cert -d` writes admin trust settings even "unelevated") —
   * runs as a single elevated shell script. Stale login-keychain certs are
   * deleted silently without `-t`: once the cert is gone its trust settings
   * can't match anything, and `-t` would raise a trust-settings dialog.
   */
  private installMacOS(): CAInstallResult {
    const current = this.fingerprint() ?? ''
    const loginKeychain = join(homedir(), 'Library', 'Keychains', 'login.keychain-db')
    const systemKeychain = '/Library/Keychains/System.keychain'

    for (const hash of this.staleMacHashes(loginKeychain, current)) {
      try {
        execFileSync('security', ['delete-certificate', '-Z', hash, loginKeychain], { stdio: 'pipe' })
      } catch {
        // Best-effort; a leftover cert without System-keychain trust is inert
        // once the elevated purge below removes the trusted copy.
      }
    }

    const adminScript = [
      ...this.staleMacHashes(systemKeychain, current).map(
        (hash) => `security delete-certificate -Z ${hash} ${shellQuote(systemKeychain)} || true`,
      ),
      `security add-trusted-cert -d -r trustRoot -p ssl -k ${shellQuote(systemKeychain)} ${shellQuote(this.certPath)}`,
    ].join(' ; ')
    try {
      if (typeof process.getuid === 'function' && process.getuid() === 0) {
        execSync(adminScript, { stdio: 'pipe' })
      } else {
        execSync(
          `osascript -e ${shellQuote(`do shell script ${JSON.stringify(adminScript)} with administrator privileges`)}`,
          { stdio: 'pipe' },
        )
      }
      return { target: 'system-keychain' }
    } catch (adminErr) {
      // Likely a cancelled admin prompt. Fall back to the user trust domain:
      // no -d, so this touches only the login keychain and at most raises one
      // login-password trust-settings dialog.
      const adminFailure = describeTrustInstallFailure(adminErr)
      try {
        execFileSync(
          'security',
          ['add-trusted-cert', '-r', 'trustRoot', '-p', 'ssl', '-k', loginKeychain, this.certPath],
          { stdio: 'pipe' },
        )
        return {
          target: 'login-keychain',
          warning: [
            `The certificate is trusted for your user account, but system-wide trust was skipped because ${adminFailure.reason}.`,
            'If a connected app can\'t reach Antseed, connect it again and approve the administrator prompt.',
          ].join(' '),
          detail: adminFailure.detail,
        }
      } catch (loginErr) {
        const loginFailure = describeTrustInstallFailure(loginErr)
        throw new Error(
          `The certificate could not be trusted automatically because ${adminFailure.reason}. `
          + `Trust it manually by opening ${this.certPath} in Keychain Access, or connect again and approve the prompt. `
          + `(${adminFailure.detail}; ${loginFailure.detail})`,
        )
      }
    }
  }

  /**
   * `certutil -addstore Root` always targets the Local Machine store, which
   * requires administrator rights — Node can't request elevation directly,
   * so both the stale-cert purge and the add run as ONE elevated `cmd.exe`
   * (one UAC prompt) via PowerShell's `Start-Process -Verb RunAs`.
   */
  private installWindows(): CAInstallResult {
    const current = this.fingerprint()
    const staleHashes = [...new Set(this.listInstalledFingerprints().map(normalizeFingerprint))]
      .filter((hash) => hash && hash !== current)

    const commands = [
      ...staleHashes.map((hash) => `certutil -delstore -f Root ${hash}`),
      `certutil -addstore -f Root "${this.certPath}"`,
    ]
    try {
      this.runElevatedCertutil(commands)
      return { target: 'windows-root' }
    } catch (err) {
      const failure = describeTrustInstallFailure(err)
      throw new Error(
        `The certificate could not be trusted automatically because ${failure.reason}. `
        + `Trust it manually: open ${this.certPath}, click "Install Certificate", choose "Local Machine", `
        + 'and place it in "Trusted Root Certification Authorities". '
        + `(${failure.detail})`,
      )
    }
  }

  /**
   * Runs `commands` inside one elevated `cmd.exe`, redirecting its combined
   * stdout+stderr to a temp file — an elevated child's stdio can't be piped
   * back to this process directly, and `certutil` writes its real errors
   * (e.g. "Access is denied") to stdout, which a plain `execFileSync` never
   * surfaces.
   */
  private runElevatedCertutil(commands: string[]): void {
    const outFile = join(tmpdir(), `antseed-ca-install-${randomUUID()}.log`)
    const innerCmd = `${commands.join(' & ')} > "${outFile}" 2>&1`
    const psCommand = [
      `$p = Start-Process -FilePath cmd.exe -ArgumentList '/d','/c',${psQuote(innerCmd)} -Verb RunAs -Wait -PassThru -WindowStyle Hidden`,
      'exit $p.ExitCode',
    ].join('; ')

    let execErr: unknown = null
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], { stdio: 'pipe' })
    } catch (err) {
      execErr = err
    }

    let fileOutput = ''
    try {
      fileOutput = readFileSync(outFile, 'utf8').trim()
    } catch {
      // Elevation itself may have failed before certutil ever ran.
    } finally {
      try { unlinkSync(outFile) } catch { /* best-effort cleanup */ }
    }

    if (execErr) {
      throw new Error(fileOutput || commandErrorDetail(execErr))
    }
  }
}
