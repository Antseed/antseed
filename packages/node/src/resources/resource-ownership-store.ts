import Database from 'better-sqlite3';
import { runMigrations } from '../storage/migrate.js';
import { meteringMigrations } from '../storage/migrations/metering/index.js';
import type { SerializedHttpResponse } from '../types/http.js';

const RETENTION_MS = 30 * 24 * 60 * 60_000;

export type StoredVideoResponse = Pick<SerializedHttpResponse, 'statusCode' | 'headers' | 'body'>;

interface ReplayRow {
  status_code: number;
  headers_json: string;
  body: Buffer;
}

/**
 * Seller-side owner of each accepted video job, plus its replayable acceptance keyed by buyer idempotency key.
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
    this._db.prepare('DELETE FROM resource_idempotency WHERE created_at < ?').run(cutoff);
  }

  getOwner(protocol: string, resourceId: string): string | null {
    const row = this._db.prepare('SELECT buyer_peer_id FROM resource_owners WHERE protocol = ? AND resource_id = ?')
      .get(protocol, resourceId) as { buyer_peer_id: string } | undefined;
    return row?.buyer_peer_id ?? null;
  }

  getReplay(buyerPeerId: string, protocol: string, idempotencyKey: string): StoredVideoResponse | null {
    const row = this._db.prepare(`
      SELECT status_code, headers_json, body FROM resource_idempotency
      WHERE buyer_peer_id = ? AND protocol = ? AND idempotency_key = ?
    `).get(buyerPeerId, protocol, idempotencyKey) as ReplayRow | undefined;
    if (!row) return null;
    return {
      statusCode: row.status_code,
      headers: JSON.parse(row.headers_json) as Record<string, string>,
      body: new Uint8Array(row.body),
    };
  }

  recordAcceptedCreate(protocol: string, resourceId: string, buyerPeerId: string, idempotencyKey?: string, response?: StoredVideoResponse): void {
    const createdAt = this._now();
    this._db.transaction(() => {
      this._db.prepare(`
        INSERT INTO resource_owners (protocol, resource_id, buyer_peer_id, created_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(protocol, resource_id) DO NOTHING
      `).run(protocol, resourceId, buyerPeerId, createdAt);
      if (idempotencyKey && response) {
        this._db.prepare(`
          INSERT INTO resource_idempotency (buyer_peer_id, protocol, idempotency_key, status_code, headers_json, body, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(buyer_peer_id, protocol, idempotency_key) DO NOTHING
        `).run(buyerPeerId, protocol, idempotencyKey, response.statusCode, JSON.stringify(response.headers), Buffer.from(response.body), createdAt);
      }
    })();
  }

  close(): void {
    this._db.close();
  }
}
