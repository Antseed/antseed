import {
  assertNewIdentityPassphrase,
  type FileIdentityStore,
  MIN_PASSPHRASE_LENGTH,
  PASSPHRASE_ENV,
  PASSPHRASE_FILE_ENV,
  resolveIdentityPassphrase,
  setIdentityPassphrase,
} from '@antseed/node'
import { storedWalletKeys } from '../buyer-identities/store.js'
import { promptHidden } from './prompt-hidden.js'

export interface PassphrasePrompt {
  /** Whether there is a terminal to ask on. */
  readonly available: boolean
  /** Asks without echoing the answer. */
  ask(question: string): Promise<string>
}

/**
 * Set by `gateway start` on the buyer it runs: the wallet passphrase comes on
 * stdin, so it is never in that process's environment.
 */
export const PASSPHRASE_STDIN_ENV = 'ANTSEED_PASSPHRASE_STDIN'

/** Reads a passphrase handed on over stdin (see PASSPHRASE_STDIN_ENV) and uses it for this process. */
async function takePassphraseFromStdin(): Promise<void> {
  if (process.env[PASSPHRASE_STDIN_ENV] !== '1') return
  delete process.env[PASSPHRASE_STDIN_ENV]
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  const passphrase = Buffer.concat(chunks).toString('utf8').split(/\r?\n/, 1)[0] ?? ''
  if (!passphrase) throw new Error(`${PASSPHRASE_STDIN_ENV} is set but no passphrase came on stdin.`)
  setIdentityPassphrase(passphrase)
}

const terminal: PassphrasePrompt = {
  get available() { return process.stdin.isTTY === true },
  ask: (question) => promptHidden(question),
}

/**
 * The wallet passphrase: ANTSEED_PASSPHRASE / ANTSEED_PASSPHRASE_FILE, else
 * asked on the terminal and used for the rest of this process like the
 * variable (a buyer the gateway starts gets it on stdin; it is never written).
 * Null when neither is set and stdin is not a terminal. `confirm` asks twice
 * and requires the length for a new passphrase, for encrypting keys with it.
 */
export async function walletPassphrase(options: { confirm?: boolean; prompt?: PassphrasePrompt } = {}): Promise<string | null> {
  const configured = resolveIdentityPassphrase()
  if (configured) return configured
  const prompt = options.prompt ?? terminal
  if (!prompt.available) return null
  if (!options.confirm) {
    const passphrase = await prompt.ask('Wallet passphrase: ')
    if (!passphrase) return null
    setIdentityPassphrase(passphrase)
    return passphrase
  }
  const passphrase = await prompt.ask(`New wallet passphrase (at least ${MIN_PASSPHRASE_LENGTH} characters): `)
  assertNewIdentityPassphrase(passphrase, 'The passphrase')
  if (await prompt.ask('Repeat the passphrase: ') !== passphrase) throw new Error('The passphrases do not match.')
  setIdentityPassphrase(passphrase)
  return passphrase
}

/** True when any of these stored wallet keys is encrypted. */
export async function anyKeyEncrypted(keys: Array<{ store: FileIdentityStore }>): Promise<boolean> {
  for (const key of keys) {
    if (await key.store.format().catch(() => null) === 'encrypted') return true
  }
  return false
}

/** Wrong answers on the terminal before giving up. */
const MAX_ATTEMPTS = 3

/** The first stored wallet key in the data dir that is encrypted, if any. */
async function firstEncryptedKey(dataDir: string): Promise<{ name: string; store: FileIdentityStore } | null> {
  for (const key of await storedWalletKeys(dataDir)) {
    if (await key.store.format().catch(() => null) === 'encrypted') return key
  }
  return null
}

/**
 * The wallet passphrase, checked against the data dir's encrypted wallet
 * keys before anything uses it: every key it encrypts later (a new buyer
 * identity, a gateway workspace) must open with the same passphrase as those
 * already encrypted. A configured one that does not open them throws; one
 * typed on the terminal is asked again. With no encrypted key there is
 * nothing to check against: `confirmNew` then asks for a new passphrase
 * twice, otherwise only a configured one is returned.
 */
export async function verifiedWalletPassphrase(
  dataDir: string,
  options: { confirmNew?: boolean; prompt?: PassphrasePrompt } = {},
): Promise<string | null> {
  await takePassphraseFromStdin()
  const encrypted = await firstEncryptedKey(dataDir)
  const configured = resolveIdentityPassphrase()
  if (configured) {
    if (encrypted && !(await encrypted.store.unlocksWith(configured))) {
      throw new Error(
        `The passphrase in ${PASSPHRASE_ENV} (or ${PASSPHRASE_FILE_ENV}) does not unlock the encrypted wallet key "${encrypted.name}" in ${dataDir}. ` +
        'Set it to the passphrase those keys were encrypted with.',
      )
    }
    return configured
  }
  if (!encrypted) return options.confirmNew ? walletPassphrase({ confirm: true, ...(options.prompt ? { prompt: options.prompt } : {}) }) : null
  const prompt = options.prompt ?? terminal
  if (!prompt.available) return null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const passphrase = await prompt.ask('Wallet passphrase: ')
    if (!passphrase) return null
    if (await encrypted.store.unlocksWith(passphrase)) {
      setIdentityPassphrase(passphrase)
      return passphrase
    }
    if (attempt < MAX_ATTEMPTS) process.stderr.write('Wrong passphrase, try again.\n')
  }
  throw new Error(`Wrong passphrase: it does not unlock the encrypted wallet key "${encrypted.name}" in ${dataDir}.`)
}

/**
 * For `buyer start` / `gateway start`: the configured passphrase, or, when a
 * stored wallet key is encrypted and none is configured, one asked on the
 * terminal; either is checked against the encrypted keys first. Null
 * otherwise; loading an encrypted key then fails as before.
 */
export function walletPassphraseForStart(dataDir: string, prompt?: PassphrasePrompt): Promise<string | null> {
  return verifiedWalletPassphrase(dataDir, prompt ? { prompt } : {})
}
