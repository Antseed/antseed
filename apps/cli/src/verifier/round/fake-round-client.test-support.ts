import { getAddress, type AbstractSigner } from 'ethers'
import {
  ZERO_HASH,
  type CommitmentEvent,
  type KbfEpochInfo,
  type KbfModel,
  type KbfRoundClient,
  type BankCommittedEvent,
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
  banks: BankCommittedEvent[] = []
  shareFiles: CommitmentEvent[] = []
  slices: CommitmentEvent[] = []
  shares: KeyShareRevealedEvent[] = []
  /** `<epoch>:<generation>:<sharesHash>:<planHash>` → verifiers that accepted that round. */
  acceptances = new Map<string, Set<string>>()
  takeoverCounts = new Map<string, number>()
  members = new Map<bigint, string[]>()
  calls: string[] = []
  /** Makes the next `commitKeyShares` calls fail, as a storage or RPC outage would. */
  failKeyShares = 0

  info(epoch: bigint): KbfEpochInfo {
    let info = this.infos.get(epoch)
    if (!info) {
      info = {
        epoch, startedAt: Number(epoch) * EPOCH_SECONDS, seedBlock: 0n, seed: ZERO_HASH, modelsVersion: 0, verifierCount: 0,
        schedule: { collectSeconds: 3 * 86400, backupSeconds: 86400, attestSeconds: 86400, probesPerService: 20, slicesPerService: 2 },
        bankHash: ZERO_HASH, bankKeyHash: ZERO_HASH, bankKey: ZERO_HASH, planHash: ZERO_HASH,
        finalizedRoot: ZERO_HASH, voided: false, publisher: ZERO_ADDRESS, takenOverAt: 0, keySharesHash: ZERO_HASH,
        planActive: false, bankGeneration: 0,
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
  private roundKey(epoch: bigint): string {
    const info = this.info(epoch)
    return `${epoch}:${info.bankGeneration}:${info.keySharesHash}:${info.planHash}`
  }
  async hasAcceptedPlan(epoch: bigint, verifier: string): Promise<boolean> {
    return this.acceptances.get(this.roundKey(epoch))?.has(getAddress(verifier)) ?? false
  }
  async planAcceptances(epoch: bigint): Promise<number> {
    return this.acceptances.get(this.roundKey(epoch))?.size ?? 0
  }
  async requiredPlanAcceptances(epoch: bigint): Promise<number> {
    const members = this.members.get(epoch) ?? []
    const publisher = this.info(epoch).publisher
    const others = members.filter((member) => getAddress(member) !== getAddress(publisher)).length
    return Math.min(await this.threshold(epoch), others)
  }
  async takeovers(epoch: bigint, verifier: string): Promise<number> {
    return this.takeoverCounts.get(`${epoch}:${getAddress(verifier)}`) ?? 0
  }
  private async activateIfAccepted(epoch: bigint): Promise<void> {
    if (await this.planAcceptances(epoch) >= await this.requiredPlanAcceptances(epoch)) {
      this.info(epoch).planActive = true
      this.calls.push(`planActivated:${epoch}`)
    }
  }
  async keyShareRevealed(epoch: bigint, verifier: string): Promise<boolean> {
    return this.shares.some((entry) => entry.epoch === epoch && entry.verifier.toLowerCase() === verifier.toLowerCase())
  }

  async bankCommits(epoch: bigint): Promise<BankCommittedEvent[]> { return this.banks.filter((entry) => entry.epoch === epoch) }

  async commitBank(signer: AbstractSigner, epoch: bigint, bankHash: string, keyHash: string, bankUri = ''): Promise<string> {
    this.banks.push({ epoch, bankHash, bankKeyHash: keyHash, bankUri, blockNumber: 1 })
    const sender = await this.sender(signer)
    if (sender !== getAddress(this.publisherAddress)) throw new Error('NotPublisher')
    const info = this.info(epoch)
    if (info.seedBlock !== 0n || info.takenOverAt !== 0) throw new Error('WrongPhase')
    Object.assign(info, { bankHash, bankKeyHash: keyHash, publisher: sender, keySharesHash: ZERO_HASH, planHash: ZERO_HASH })
    info.bankGeneration += 1
    this.calls.push(`commitBank:${epoch}`)
    return '0xtx'
  }

  async takeOverBank(signer: AbstractSigner, epoch: bigint, bankHash: string, keyHash: string, bankUri = ''): Promise<string> {
    const sender = await this.sender(signer)
    const info = this.info(epoch)
    const opened = info.seedBlock !== 0n
    const allowed = opened ? this.members.get(epoch) ?? [] : this.approved
    if (!allowed.some((entry) => getAddress(entry) === sender)) throw new Error('NotVerifier')
    const since = info.takenOverAt || info.startedAt
    if (info.planActive || this.time < since + this.graceSeconds || this.time >= this.commitDeadline(info)) {
      throw new Error('WrongPhase')
    }
    if (sender === getAddress(info.publisher) || await this.takeovers(epoch, sender) >= 2) throw new Error('WrongPhase')
    this.takeoverCounts.set(`${epoch}:${sender}`, await this.takeovers(epoch, sender) + 1)
    Object.assign(info, {
      bankHash, bankKeyHash: keyHash, publisher: sender, keySharesHash: ZERO_HASH, planHash: ZERO_HASH, takenOverAt: this.time,
    })
    info.bankGeneration += 1
    if (opened) info.seed = ZERO_HASH
    this.banks.push({ epoch, bankHash, bankKeyHash: keyHash, bankUri, blockNumber: 1 })
    this.calls.push(`takeOverBank:${epoch}:${sender}`)
    return '0xtx'
  }

  async commitKeyShares(signer: AbstractSigner, epoch: bigint, hash: string, uri: string): Promise<string> {
    const sender = await this.sender(signer)
    const info = this.info(epoch)
    if (sender !== getAddress(info.publisher)) throw new Error('NotPublisher')
    if (info.seedBlock === 0n || info.planActive || this.time >= this.commitDeadline(info)) throw new Error('WrongPhase')
    if (this.failKeyShares > 0) {
      this.failKeyShares--
      throw new Error('storage outage')
    }
    info.keySharesHash = hash
    this.shareFiles.push({ epoch, hash, uri, backup: false, sender, blockNumber: 1, logIndex: 0, txHash: '0x' })
    this.calls.push(`commitKeyShares:${epoch}`)
    return '0xtx'
  }

  async commitPlan(signer: AbstractSigner, epoch: bigint, hash: string, uri: string): Promise<string> {
    const sender = await this.sender(signer)
    const info = this.info(epoch)
    if (sender !== getAddress(info.publisher)) throw new Error('NotPublisher')
    if (info.seed === ZERO_HASH || this.time >= this.commitDeadline(info)) throw new Error('WrongPhase')
    if (info.keySharesHash === ZERO_HASH) throw new Error('KeyNotEscrowed')
    if (info.planActive) {
      if (info.planHash === hash) return '0xtx'
      throw new Error('PlanAlreadyCommitted')
    }
    info.planHash = hash
    this.plans.push({ epoch, hash, uri, backup: false, sender, blockNumber: 1, logIndex: 0, txHash: '0x' })
    this.calls.push(`commitPlan:${epoch}`)
    await this.activateIfAccepted(epoch)
    return '0xtx'
  }

  async acceptPlan(signer: AbstractSigner, epoch: bigint, bankGeneration: number, sharesHash: string, planHash: string): Promise<string> {
    const sender = await this.sender(signer)
    const info = this.info(epoch)
    if (!(this.members.get(epoch) ?? []).some((member) => getAddress(member) === sender) || sender === getAddress(info.publisher)) {
      throw new Error('NotVerifier')
    }
    if (info.planActive || info.planHash === ZERO_HASH || this.time >= this.commitDeadline(info)) throw new Error('WrongPhase')
    if (bankGeneration !== info.bankGeneration || sharesHash !== info.keySharesHash || planHash !== info.planHash) throw new Error('InvalidValue')
    const key = this.roundKey(epoch)
    const accepted = this.acceptances.get(key) ?? new Set<string>()
    if (accepted.has(sender)) throw new Error('AlreadyAccepted')
    accepted.add(sender)
    this.acceptances.set(key, accepted)
    this.calls.push(`acceptPlan:${epoch}:${sender}`)
    await this.activateIfAccepted(epoch)
    return '0xtx'
  }

  async revealKeyShare(signer: AbstractSigner, epoch: bigint, share: string): Promise<string> {
    const sender = await this.sender(signer)
    const info = this.info(epoch)
    if (!info.planActive || info.bankKey !== ZERO_HASH || this.time < this.backupDeadline(info)) throw new Error('WrongPhase')
    if (await this.keyShareRevealed(epoch, sender)) throw new Error('AlreadyRevealed')
    this.shares.push({ epoch, verifier: sender, share, blockNumber: 1, logIndex: this.shares.length })
    this.calls.push(`revealKeyShare:${epoch}:${sender}`)
    return '0xtx'
  }

  async revealBankKey(_signer: AbstractSigner, epoch: bigint, key: string): Promise<string> {
    const info = this.info(epoch)
    if (!info.planActive || info.bankKey !== ZERO_HASH || this.time < this.backupDeadline(info)) throw new Error('WrongPhase')
    if (bankKeyHash(key) !== info.bankKeyHash) throw new Error('InvalidValue')
    info.bankKey = key
    this.calls.push(`revealBankKey:${epoch}`)
    return '0xtx'
  }
}
