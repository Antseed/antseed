import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getAddress, Wallet, type AbstractSigner } from 'ethers'
import type { VerifierCLIConfig } from '../../../config/types.js'
import { loadCryptoContext } from '../../payment-utils.js'
import { promptHidden } from '../../prompt-hidden.js'

export type AuditorSource = 'flag' | 'config' | 'keystore' | 'data-dir'

export interface AuditorSigner {
  wallet: AbstractSigner
  address: string
  source: Exclude<AuditorSource, 'flag' | 'config'> | 'flag-keystore'
}

function expandHome(path: string): string {
  const value = path.trim()
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return resolve(value)
}

/** The address an encrypted JSON keystore belongs to, read without decrypting when the file records it. */
export async function keystoreAddress(path: string): Promise<string | null> {
  const parsed = JSON.parse(await readFile(expandHome(path), 'utf8')) as { address?: unknown }
  if (typeof parsed.address !== 'string' || !/^(0x)?[0-9a-fA-F]{40}$/.test(parsed.address)) return null
  return getAddress(parsed.address.startsWith('0x') ? parsed.address : `0x${parsed.address}`)
}

export async function loadKeystoreSigner(path: string): Promise<{ wallet: AbstractSigner; address: string }> {
  const resolved = expandHome(path)
  const json = await readFile(resolved, 'utf8')
  const password = process.env['ANTSEED_KEYSTORE_PASSWORD']
    || await promptHidden(`Keystore password for ${resolved}: `, 'the keystore needs a terminal to ask for the password, or set ANTSEED_KEYSTORE_PASSWORD.')
  const wallet = await Wallet.fromEncryptedJson(json, password)
  return { wallet, address: wallet.address }
}

function checkConfiguredAuditor(config: VerifierCLIConfig | undefined, address: string, from: string): void {
  if (config?.auditor && getAddress(config.auditor) !== getAddress(address)) {
    throw new Error(`verifier.auditor ${getAddress(config.auditor)} does not match ${from} ${getAddress(address)}`)
  }
}

/**
 * The auditor address without unlocking a signer, for model assignment and read-only commands:
 * `--auditor`, then `verifier.auditor`, then the address recorded in `verifier.keystore`, then the
 * data-dir identity. A keystore that does not record its address is unlocked.
 */
export async function resolveAuditorAddress(input: {
  config: VerifierCLIConfig | undefined
  dataDir: string
  flag?: string
}): Promise<{ address: string; source: AuditorSource }> {
  if (input.flag?.trim()) return { address: getAddress(input.flag.trim()), source: 'flag' }
  const keystore = input.config?.keystore
  if (input.config?.auditor) {
    const address = getAddress(input.config.auditor)
    if (keystore) {
      const recorded = await keystoreAddress(keystore)
      if (recorded) checkConfiguredAuditor(input.config, recorded, `the address in verifier.keystore`)
    }
    return { address, source: 'config' }
  }
  if (keystore) {
    const address = await keystoreAddress(keystore) ?? (await loadKeystoreSigner(keystore)).address
    return { address, source: 'keystore' }
  }
  return { address: (await loadCryptoContext(input.dataDir)).address, source: 'data-dir' }
}

/**
 * The signer for `submit` and `rewards --claim`: `--keystore`, then `verifier.keystore`, then the
 * data-dir identity. Fails when `verifier.auditor` names a different address.
 */
export async function resolveAuditorSigner(input: {
  config: VerifierCLIConfig | undefined
  dataDir: string
  keystoreFlag?: string
}): Promise<AuditorSigner> {
  const keystore = input.keystoreFlag?.trim() || input.config?.keystore
  const signer = keystore
    ? { ...await loadKeystoreSigner(keystore), source: input.keystoreFlag?.trim() ? 'flag-keystore' as const : 'keystore' as const }
    : await loadCryptoContext(input.dataDir).then(({ wallet, address }) => ({ wallet: wallet as AbstractSigner, address, source: 'data-dir' as const }))
  checkConfiguredAuditor(input.config, signer.address, keystore ? 'the keystore signer' : 'the data-dir identity')
  return signer
}

export function describeAuditorSource(source: AuditorSource): string {
  switch (source) {
    case 'flag': return '--auditor'
    case 'config': return 'verifier.auditor'
    case 'keystore': return 'verifier.keystore'
    case 'data-dir': return 'data-dir identity'
  }
}
