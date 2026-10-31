import { getAddress, type AbstractSigner } from 'ethers'
import {
  ZERO_HASH,
  type CommitmentEvent,
  type KbfEpochInfo,
  type KbfModel,
  type KbfRoundClient,
  type KeyShareRevealedEvent,
} from '@antseed/node/payments'
import { bankKeyHash } from './sealing.js'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
export const EPOCH_SECONDS = 7 * 24 * 3600

/**
 * In-memory stand-in for AntseedKbfVerification with the round's phase rules, enough to drive
 * the publisher, fallback-publisher and key-escrow ticks in unit tests.
 */
export class FakeRoundClient {
  epoch = 7n
  time = 0
  graceSeconds = 6 * 3600
  publisherAddress = ZERO_ADDRESS
  approved: string[] = []
  encryptionKeys = new Map<string, string>()
  modelList: KbfModel[] = []
  infos = new Map<bigint, KbfEpochInfo>()
  plans: CommitmentEvent[] = []
  shareFiles: CommitmentEvent[] = []
  slices: CommitmentEvent[] = []
  shares: KeyShareRevealedEvent[] = []
  members = new Map<bigint, string[]>()
  calls: string[] = []

  info(epoch: bigint): KbfEpochInfo {
    let info = this.infos.get(epoch)
    if (!info) {
      info = {
        epoch, startedAt: Number(epoch) * EPOCH_SECONDS, seedBlock: 0n, seed: ZERO_HASH, modelsVersion: 0, verifierCount: 0,
        schedule: { collectSeconds: 3 * 86400, backupSeconds: 86400, attestSeconds: 86400, probesPerService: 20, slicesPerService: 2 },
        bankHash: ZERO_HASH, bankKeyHash: ZERO_HASH, bankKey: ZERO_HASH, planHash: ZERO_HASH, backupPlanHash: ZERO_HASH,
        finalizedRoot: ZERO_HASH, voided: false, publisher: ZERO_ADDRESS, takenOverAt: 0, keySharesHash: ZERO_HASH,
      }
      this.infos.set(epoch, info)
    }
    return info
  }

  /** Opens and seeds the epoch with the current approved verifiers. */
  openAndSeed(epoch: bigint, seed = `0x${'ab'.repeat(32)}`): void {
    const info = this.info(epoch)
    info.seedBlock = 10n
    info.seed = seed
    info.modelsVersion = 1
    info.verifierCount = this.approved.length
    this.members.set(epoch, [...this.approved])
  }

  asClient(): KbfRoundClient {
    return this as unknown as KbfRoundClient
  }

  private async sender(signer: AbstractSigner): Promise<string> {
    return getAddress(await signer.getAddress())
  }

  private commitDeadline(info: KbfEpochInfo): number {
    return info.startedAt + info.schedule.collectSeconds
  }

  private backupDeadline(info: KbfEpochInfo): number {
    return this.commitDeadline(info) + info.schedule.backupSeconds
  }

  async currentEpoch(): Promise<bigint> { return this.epoch }
  async epochDuration(): Promise<number> { return EPOCH_SECONDS }
  async now(): Promise<number> { return this.time }
  async epochInfo(epoch: bigint): Promise<KbfEpochInfo> { return { ...this.info(epoch) } }
  async publisherGraceSeconds(): Promise<number> { return this.graceSeconds }
  async modelsVersion(): Promise<number> { return this.modelList.length > 0 ? 1 : 0 }
  async models(): Promise<KbfModel[]> { return this.modelList }
  async verifiers(): Promise<string[]> { return [...this.approved] }
  async epochVerifiers(epoch: bigint): Promise<string[]> { return [...(this.members.get(epoch) ?? [])] }
  async threshold(epoch: bigint): Promise<number> { return Math.floor((this.members.get(epoch)?.length ?? 0) / 2) + 1 }
  async encryptionKey(address: string): Promise<string> { return this.encryptionKeys.get(address.toLowerCase()) ?? ZERO_HASH }
  async planCommits(epoch: bigint): Promise<CommitmentEvent[]> { return this.plans.filter((entry) => entry.epoch === epoch) }
  async sliceCommits(epoch: bigint): Promise<CommitmentEvent[]> { return this.slices.filter((entry) => entry.epoch === epoch) }
  async keySharesCommits(epoch: bigint): Promise<CommitmentEvent[]> { return this.shareFiles.filter((entry) => entry.epoch === epoch) }
  async keyShareReveals(epoch: bigint): Promise<KeyShareRevealedEvent[]> { return this.shares.filter((entry) => entry.epoch === epoch) }
  async keyShareRevealed(epoch: bigint, verifier: string): Promise<boolean> {
    return this.shares.some((entry) => entry.epoch === epoch && entry.verifier.toLowerCase() === verifier.toLowerCase())
  }

  async commitBank(signer: AbstractSigner, epoch: bigint, bankHash: string, keyHash: string): Promise<string> {
    const sender = await this.sender(signer)
    if (sender !== getAddress(this.publisherAddress)) throw new Error('NotPublisher')
    const info = this.info(epoch)
    if (info.seedBlock !== 0n || info.takenOverAt !== 0) throw new Error('WrongPhase')
    Object.assign(info, { bankHash, bankKeyHash: keyHash, publisher: sender, keySharesHash: ZERO_HASH })
    this.calls.push(`commitBank:${epoch}`)
    return '0xtx'
  }

  async takeOverBank(signer: AbstractSigner, epoch: bigint, bankHash: string, keyHash: string): Promise<string> {
    const sender = await this.sender(signer)
    const info = this.info(epoch)
    const opened = info.seedBlock !== 0n
    const allowed = opened ? this.members.get(epoch) ?? [] : this.approved
    if (!allowed.some((entry) => getAddress(entry) === sender)) throw new Error('NotVerifier')
    const since = info.takenOverAt || info.startedAt
    if (info.planHash !== ZERO_HASH || this.time < since + this.graceSeconds || this.time >= this.commitDeadline(info)) {
      throw new Error('WrongPhase')
    }
    Object.assign(info, { bankHash, bankKeyHash: keyHash, publisher: sender, keySharesHash: ZERO_HASH, takenOverAt: this.time })
    if (opened) info.seed = ZERO_HASH
    this.calls.push(`takeOverBank:${epoch}:${sender}`)
    return '0xtx'
  }

  async commitKeyShares(signer: AbstractSigner, epoch: bigint, hash: string, uri: string): Promise<string> {
    const sender = await this.sender(signer)
    const info = this.info(epoch)
    if (sender !== getAddress(info.publisher)) throw new Error('NotPublisher')
    if (info.seedBlock === 0n || this.time >= this.commitDeadline(info)) throw new Error('WrongPhase')
    info.keySharesHash = hash
    this.shareFiles.push({ epoch, hash, uri, backup: false, sender, blockNumber: 1, logIndex: 0, txHash: '0x' })
    this.calls.push(`commitKeyShares:${epoch}`)
    return '0xtx'
  }

  async commitPlan(signer: AbstractSigner, epoch: bigint, hash: string, uri: string, backup = false): Promise<string> {
    const sender = await this.sender(signer)
    const info = this.info(epoch)
    if (sender !== getAddress(info.publisher)) throw new Error('NotPublisher')
    if (backup) {
      if (this.time < this.commitDeadline(info) || this.time >= this.backupDeadline(info)) throw new Error('WrongPhase')
      info.backupPlanHash = hash
    } else {
      if (info.seed === ZERO_HASH || this.time >= this.commitDeadline(info)) throw new Error('WrongPhase')
      info.planHash = hash
    }
    this.plans.push({ epoch, hash, uri, backup, sender, blockNumber: 1, logIndex: 0, txHash: '0x' })
    this.calls.push(`${backup ? 'commitBackupPlan' : 'commitPlan'}:${epoch}`)
    return '0xtx'
  }

  async revealKeyShare(signer: AbstractSigner, epoch: bigint, share: string): Promise<string> {
    const sender = await this.sender(signer)
    const info = this.info(epoch)
    if (info.keySharesHash === ZERO_HASH || info.bankKey !== ZERO_HASH || this.time < this.backupDeadline(info)) throw new Error('WrongPhase')
    if (await this.keyShareRevealed(epoch, sender)) throw new Error('AlreadyRevealed')
    this.shares.push({ epoch, verifier: sender, share, blockNumber: 1, logIndex: this.shares.length })
    this.calls.push(`revealKeyShare:${epoch}:${sender}`)
    return '0xtx'
  }

  async revealBankKey(_signer: AbstractSigner, epoch: bigint, key: string): Promise<string> {
    const info = this.info(epoch)
    if (info.planHash === ZERO_HASH || info.bankKey !== ZERO_HASH || this.time < this.backupDeadline(info)) throw new Error('WrongPhase')
    if (bankKeyHash(key) !== info.bankKeyHash) throw new Error('InvalidValue')
    info.bankKey = key
    this.calls.push(`revealBankKey:${epoch}`)
    return '0xtx'
  }
}
