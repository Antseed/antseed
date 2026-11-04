import { spawnSync } from 'node:child_process'

/** A config fragment that can carry an upstream API key in any of three ways. */
export interface ApiKeySource {
  /** Highest precedence: run this command (argv) and read the key from its stdout. */
  apiKeyCommand?: readonly string[]
  /** Read the key from this environment variable. */
  apiKeyEnv?: string
  /** Inline key value (lowest precedence). */
  apiKey?: string
}

/**
 * Resolve an upstream API key from its config.
 *
 * Precedence: `apiKeyCommand` (run it, read stdout) → `apiKeyEnv` (`process.env`) → inline `apiKey`.
 * Returns `undefined` when none yields a value, exactly as `apiKeyEnv ?? apiKey` did before.
 *
 * `apiKeyCommand` lets operators keep their keys encrypted at rest with whatever tool they like
 * (age, gpg, sops, a cloud KMS/HSM, a company secret-box, …): the CLI runs the command and reads the
 * key from stdout, so it never stores a ciphertext or implements any cryptography of its own. The
 * command runs once, failures are loud, and the resolved value is never logged.
 */
export function resolveApiKey(source: ApiKeySource, label = 'upstream'): string | undefined {
  const command = source.apiKeyCommand
  if (command && command.length > 0) {
    const [bin, ...args] = command
    if (!bin) throw new Error(`${label}: apiKeyCommand must start with a program to run`)
    const result = spawnSync(bin, args, {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    })
    if (result.error) {
      throw new Error(`${label}: apiKeyCommand failed to run (${result.error.message})`)
    }
    if (result.status !== 0) {
      const detail = (result.stderr ?? '').toString().trim().slice(-300)
      throw new Error(
        `${label}: apiKeyCommand exited with ${result.status ?? result.signal ?? 'an error'}${detail ? `: ${detail}` : ''}`,
      )
    }
    const key = (result.stdout ?? '').toString().trim()
    if (!key) throw new Error(`${label}: apiKeyCommand produced no key on stdout`)
    return key
  }
  const fromEnv = source.apiKeyEnv ? process.env[source.apiKeyEnv] : undefined
  return fromEnv ?? source.apiKey
}
