import {
  assertNewIdentityPassphrase,
  type FileIdentityStore,
  MIN_PASSPHRASE_LENGTH,
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

const terminal: PassphrasePrompt = {
  get available() { return process.stdin.isTTY === true },
  ask: (question) => promptHidden(question),
}

/**
 * The wallet passphrase: ANTSEED_PASSPHRASE / ANTSEED_PASSPHRASE_FILE, else
 * asked on the terminal and used for the rest of this process like the
 * variable (child processes get it the same way; it is never written).
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

/**
 * For `buyer start` / `gateway start`: the configured passphrase, or, when a
 * stored wallet key is encrypted and none is configured, one asked on the
 * terminal. Null otherwise; loading an encrypted key then fails as before.
 */
export async function walletPassphraseForStart(dataDir: string, prompt?: PassphrasePrompt): Promise<string | null> {
  const configured = resolveIdentityPassphrase()
  if (configured) return configured
  if (!(await anyKeyEncrypted(await storedWalletKeys(dataDir)))) return null
  return walletPassphrase(prompt ? { prompt } : {})
}
