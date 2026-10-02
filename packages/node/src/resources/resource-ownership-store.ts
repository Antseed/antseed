import Database from 'better-sqlite3';
import { runMigrations } from '../storage/migrate.js';
import { meteringMigrations } from '../storage/migrations/metering/index.js';
import type { UnitBillingUsageReportV1 } from '../types/billing.js';

const RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Price of an accepted video job, charged once when the buyer downloads it. */
export interface PendingResourceCharge {
  /** Payment channel that was open when the job was accepted. */
  channelId: string;
  service: string;
  amount: bigint;
  billingUsage: UnitBillingUsageReportV1;
  /** Requested video length; a delivery must reach most of it to be charged. */
  durationSeconds?: number;
}

/**
 * Seller-side owner of each accepted video job, plus its pending delivery charge.
 * Tables live in the seller's metering database.
 */
export class ResourceOwnershipStore {
  private readonly _db: Database.Database;

  constructor(dbPath: string, private readonly _now: () => number = Date.now) {
    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');
    runMigrations(this._db, meteringMigrations);
    const cutoff = this._now() - RETENTION_MS;
    this._db.prepare('DELETE FROM resource_owners WHERE created_at < ?').run(cutoff);
    this._db.prepare('DELETE FROM resource_charges WHERE created_at < ?').run(cutoff);
  }

  getOwner(protocol: string, resourceId: string): string | null {
    const row = this._db.prepare('SELECT buyer_peer_id FROM resource_owners WHERE protocol = ? AND resource_id = ?')
      .get(protocol, resourceId) as { buyer_peer_id: string } | undefined;
    return row?.buyer_peer_id ?? null;
  }

  recordAcceptedCreate(
    protocol: string,
    resourceId: string,
    buyerPeerId: string,
    charge?: PendingResourceCharge,
  ): void {
    const createdAt = this._now();
    this._db.transaction(() => {
      if (charge) {
        this._db.prepare(`
          INSERT INTO resource_charges (protocol, resource_id, buyer_peer_id, channel_id, service, amount, billing_usage_json, duration_seconds, charged_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(protocol, resource_id) DO NOTHING
        `).run(protocol, resourceId, buyerPeerId, charge.channelId, charge.service, charge.amount.toString(), JSON.stringify(charge.billingUsage), charge.durationSeconds ?? null, createdAt);
      }
      this._db.prepare(`
        INSERT INTO resource_owners (protocol, resource_id, buyer_peer_id, created_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(protocol, resource_id) DO NOTHING
      `).run(protocol, resourceId, buyerPeerId, createdAt);
    })();
  }

  /** The job's price if it has not been charged yet. */
  getPendingCharge(protocol: string, resourceId: string, buyerPeerId: string): PendingResourceCharge | null {
    const row = this._db.prepare(`
      SELECT channel_id, service, amount, billing_usage_json, duration_seconds FROM resource_charges
      WHERE protocol = ? AND resource_id = ? AND buyer_peer_id = ? AND charged_at IS NULL
    `).get(protocol, resourceId, buyerPeerId) as { channel_id: string; service: string; amount: string; billing_usage_json: string; duration_seconds: number | null } | undefined;
    if (!row) return null;
    return {
      channelId: row.channel_id,
      service: row.service,
      amount: BigInt(row.amount),
      billingUsage: JSON.parse(row.billing_usage_json) as UnitBillingUsageReportV1,
      ...(row.duration_seconds ? { durationSeconds: row.duration_seconds } : {}),
    };
  }

  /**
   * Total price of videos accepted on this channel but not yet downloaded.
   * The reserve must keep room for them so their charge stays claimable.
   */
  getPendingChargeTotal(channelId: string): bigint {
    const rows = this._db.prepare('SELECT amount FROM resource_charges WHERE channel_id = ? AND charged_at IS NULL')
      .all(channelId) as Array<{ amount: string }>;
    return rows.reduce((total, row) => total + BigInt(row.amount), 0n);
  }

  /** Mark the job charged. Returns false when another delivery already charged it. */
  markCharged(protocol: string, resourceId: string): boolean {
    const result = this._db.prepare(`
      UPDATE resource_charges SET charged_at = ? WHERE protocol = ? AND resource_id = ? AND charged_at IS NULL
    `).run(this._now(), protocol, resourceId);
    return result.changes > 0;
  }

  /** Undo markCharged when the spend could not be recorded. */
  unmarkCharged(protocol: string, resourceId: string): void {
    this._db.prepare('UPDATE resource_charges SET charged_at = NULL WHERE protocol = ? AND resource_id = ?').run(protocol, resourceId);
  }

  close(): void {
    this._db.close();
  }
}
