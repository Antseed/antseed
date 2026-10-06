import { DEFAULT_BUYER_IDENTITY, type AntseedNode, type Identity } from '@antseed/node'
import { listBuyerIdentities, loadBuyerIdentity, type StoredBuyerIdentity } from './store.js'

type IdentityNode = Pick<AntseedNode, 'hasBuyerIdentity' | 'addBuyerIdentity'>

/**
 * Loads stored buyer identities into a running buyer node. Identities are
 * loaded at startup and on first use, so one created while the buyer runs
 * works without a restart.
 */
export class BuyerIdentityLoader {
  private readonly _pending = new Map<string, Promise<boolean>>()

  constructor(
    private readonly _node: IdentityNode,
    private readonly _dataDir: string,
    /** Called once per identity after it joins the node (e.g. to watch its wallet for deposits). */
    private readonly _onLoaded?: (name: string, identity: Identity) => void,
  ) {}

  /** True when the node can pay as `name`, loading it from disk if needed. */
  ensure(name: string): Promise<boolean> {
    if (name === DEFAULT_BUYER_IDENTITY || this._node.hasBuyerIdentity(name)) return Promise.resolve(true)
    let pending = this._pending.get(name)
    if (!pending) {
      pending = this._load(name).finally(() => this._pending.delete(name))
      this._pending.set(name, pending)
    }
    return pending
  }

  async loadAll(): Promise<StoredBuyerIdentity[]> {
    const stored = await listBuyerIdentities(this._dataDir)
    const loaded: StoredBuyerIdentity[] = []
    for (const entry of stored) {
      if (await this.ensure(entry.name).catch(() => false)) loaded.push(entry)
    }
    return loaded
  }

  private async _load(name: string): Promise<boolean> {
    const identity = await loadBuyerIdentity(this._dataDir, name)
    if (!identity) return false
    await this._node.addBuyerIdentity(name, identity)
    this._onLoaded?.(name, identity)
    return true
  }
}
