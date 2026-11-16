/**
 * Deposits credited to each buyer wallet, kept so the gateway can issue a
 * confirmation for every one of them. The deposit watcher only reports its
 * latest event, and public RPC endpoints cannot search a wallet's history
 * (they cap log queries at a few thousand blocks), so the buyer writes each
 * credited deposit down as it happens: one JSON line per deposit, one file per
 * wallet, under the data directory. The chain stays the source of truth; the
 * gateway verifies every entry against the transaction receipt.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface DepositLogEntry {
  /** The transaction that credited the deposits balance (the relay's sweep, or a direct deposit). */
  txHash: string
  /** USDC base units credited, after the relay fee. */
  creditedBaseUnits: string
  /** When the watcher saw it credited (epoch ms). */
  at: number
}

const TX_HASH_RE = /^0x[0-9a-f]{64}$/

export class DepositLog {
  private readonly dir: string
  /** Appends run one at a time, so two events for the same deposit cannot both pass the duplicate check. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(stateDir: string) {
    this.dir = join(stateDir, 'deposits')
  }

  private file(address: string): string {
    return join(this.dir, `${address.toLowerCase()}.jsonl`)
  }

  /** Records a credited deposit once (the watcher can report the same one again when it backfills the hash). */
  record(address: string, entry: DepositLogEntry): Promise<void> {
    const txHash = entry.txHash.toLowerCase()
    if (!TX_HASH_RE.test(txHash)) return Promise.resolve()
    const run = this.queue.then(async () => {
      const existing = await this.list(address)
      if (existing.some((row) => row.txHash === txHash)) return
      await mkdir(this.dir, { recursive: true })
      await appendFile(this.file(address), `${JSON.stringify({ ...entry, txHash })}\n`, 'utf8')
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  /** The wallet's credited deposits, oldest first; unreadable lines are skipped. */
  async list(address: string): Promise<DepositLogEntry[]> {
    let text: string
    try {
      text = await readFile(this.file(address), 'utf8')
    } catch {
      return []
    }
    const rows: DepositLogEntry[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line) as Partial<DepositLogEntry>
        if (typeof row.txHash === 'string' && TX_HASH_RE.test(row.txHash) && typeof row.creditedBaseUnits === 'string' && typeof row.at === 'number') {
          rows.push({ txHash: row.txHash, creditedBaseUnits: row.creditedBaseUnits, at: row.at })
        }
      } catch {
        // A torn last line (crash mid-write) is ignored; the deposit can still be added by its transaction hash.
      }
    }
    return rows
  }
}
