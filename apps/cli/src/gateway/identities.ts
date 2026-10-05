import { randomBytes } from 'node:crypto'
import { FileIdentityStore, identityFromPrivateKeyHex } from '@antseed/node'
import { managedIdentityDir, type GatewayIdentity, type GatewayStore } from './store.js'

/** Ports the default buyer, gateway and local helpers already use. */
export const RESERVED_LOCAL_PORTS = [8377, 8378, 8379, 8380]

/**
 * Create a buyer identity the gateway runs itself: its own data dir, wallet
 * and buyer port. The wallet is generated here directly rather than through
 * loadOrCreateIdentity, which would adopt an ANTSEED_IDENTITY_HEX inherited
 * from a parent process and give every identity the same wallet.
 */
export async function provisionManagedIdentity(
  store: GatewayStore,
  dataDir: string,
  id: string,
  reservedPorts: readonly number[] = RESERVED_LOCAL_PORTS,
): Promise<GatewayIdentity> {
  if (store.getIdentity(id)) throw new Error(`Identity "${id}" already exists.`)
  const dir = managedIdentityDir(dataDir, id)
  const fileStore = new FileIdentityStore(dir)
  let hex = await fileStore.load()
  if (hex === null) {
    hex = randomBytes(32).toString('hex')
    await fileStore.save(hex)
  }
  const address = identityFromPrivateKeyHex(hex).wallet.address
  return store.createIdentity({ id, dataDir: dir, buyerPort: store.nextManagedBuyerPort(reservedPorts), address })
}

/** Wallet address of an existing CLI identity, without creating one. */
export async function readIdentityAddress(dataDir: string): Promise<string | null> {
  try {
    const hex = await new FileIdentityStore(dataDir).load()
    return hex && hex.length === 64 ? identityFromPrivateKeyHex(hex).wallet.address : null
  } catch {
    // e.g. an app-encrypted desktop identity the CLI cannot read.
    return null
  }
}
