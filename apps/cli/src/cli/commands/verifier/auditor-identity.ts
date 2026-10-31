import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getAddress, Wallet, type AbstractSigner } from 'ethers'
import type { VerifierCLIConfig } from '../../../config/types.js'
import { loadCryptoContext } from '../../payment-utils.js'
import { promptHidden } from '../../prompt-hidden.js'

export interface AuditorSigner {
  wallet: AbstractSigner
  address: string
  source: 'keystore' | 'flag-keystore' | 'data-dir'
}

function expandHome(path: string): string {
  const value = path.trim()
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return resolve(value)
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
 * The signer for `verifier start` and `verifier publish`: `--keystore`, then `verifier.keystore`, then the
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
