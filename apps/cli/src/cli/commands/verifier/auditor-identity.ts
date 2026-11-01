import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getAddress, Wallet, type AbstractSigner } from 'ethers'
import type { VerifierCLIConfig } from '../../../config/types.js'
import { listBuyerIdentities, readDefaultWallet, storedDefaultIdentityAddress } from '../../../buyer-identities/store.js'
import { promptHidden } from '../../prompt-hidden.js'

export interface AuditorSigner {
  wallet: AbstractSigner
  address: string
  source: 'keystore' | 'flag-keystore'
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

const IDENTITY_HEX_ENV = 'ANTSEED_IDENTITY_HEX'

/** Explains how to give a verifier its own key; the buyer's hot wallet only ever signs. */
export const DEDICATED_SIGNER_HELP =
  'Create a dedicated verifier key (for example `cast wallet new ~/.antseed-verifier-keystore` or '
  + '`cast wallet import verifier --interactive`), fund that address with ETH for gas, and pass it with '
  + '--keystore or verifier.keystore (password from ANTSEED_KEYSTORE_PASSWORD).'

/**
 * Every buyer hot-wallet address of a data dir: the default identity (as the buyer loads it,
 * including ANTSEED_IDENTITY_HEX), the stored identity.key, and each named buyer identity.
 */
export async function buyerHotAddresses(dataDir: string): Promise<Set<string>> {
  const addresses = new Set<string>()
  const add = (address: string | null | undefined) => {
    if (address) addresses.add(getAddress(address))
  }
  // Reading the default identity consumes ANTSEED_IDENTITY_HEX (the node clears it once loaded),
  // but the buyer this command starts next must still inherit it: put it back.
  const envIdentity = process.env[IDENTITY_HEX_ENV]
  try {
    add((await readDefaultWallet(dataDir).catch(() => ({ address: null }))).address)
  } finally {
    if (envIdentity !== undefined) process.env[IDENTITY_HEX_ENV] = envIdentity
  }
  add(await storedDefaultIdentityAddress(dataDir))
  for (const identity of await listBuyerIdentities(dataDir)) add(identity.address)
  return addresses
}

/**
 * The signer for `verifier start` and `verifier publish`: `--keystore`, then `verifier.keystore`.
 * The verifier pays gas and receives ANTS rewards, so it must be a dedicated key: there is no
 * fallback to the data-dir identity, and a keystore that resolves to any of the data dir's buyer
 * wallets is refused. Fails when `verifier.auditor` names a different address.
 */
export async function resolveAuditorSigner(input: {
  config: VerifierCLIConfig | undefined
  dataDir: string
  keystoreFlag?: string
}): Promise<AuditorSigner> {
  const flag = input.keystoreFlag?.trim()
  const keystore = flag || input.config?.keystore?.trim()
  if (!keystore) {
    throw new Error(`verifier start and verifier publish need a dedicated signer, never the buyer identity. ${DEDICATED_SIGNER_HELP}`)
  }
  const signer = { ...await loadKeystoreSigner(keystore), source: flag ? 'flag-keystore' as const : 'keystore' as const }
  if ((await buyerHotAddresses(input.dataDir)).has(getAddress(signer.address))) {
    throw new Error(`the verifier keystore ${getAddress(signer.address)} is a buyer wallet of this data dir; the buyer wallet must never pay gas or receive rewards. ${DEDICATED_SIGNER_HELP}`)
  }
  checkConfiguredAuditor(input.config, signer.address, 'the keystore signer')
  return signer
}
