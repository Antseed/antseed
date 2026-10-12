import Database from 'better-sqlite3';
import type { ResponseAuthPayload } from '../types/protocol.js';
import { runMigrations } from '../storage/migrate.js';
import { verificationMigrations } from '../storage/migrations/verification/index.js';

export interface StoredResponseAuth extends ResponseAuthPayload {
  receivedAt: number;
  verified: boolean;
  verificationError: string | null;
  requestPreimage?: Uint8Array | null;
  responsePreimage?: Uint8Array | null;
}

export class VerificationStorage {
  private readonly _db: Database.Database;
  private readonly _insertResponseAuth: Database.Statement;
  private readonly _getResponseAuth: Database.Statement;
  private readonly _listResponseAuthsBySeller: Database.Statement;

  constructor(dbPath: string) {
    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');
    runMigrations(this._db, verificationMigrations);

    const statements = this._prepareStatements();
    this._insertResponseAuth = statements.insertResponseAuth;
    this._getResponseAuth = statements.getResponseAuth;
    this._listResponseAuthsBySeller = statements.listResponseAuthsBySeller;
  }

  private _prepareStatements(): VerificationStorageStatements {
    return {
      insertResponseAuth: this._prepareInsertResponseAuthStatement(),
      getResponseAuth: this._db.prepare('SELECT * FROM response_auths WHERE request_id = ?'),
      listResponseAuthsBySeller: this._db.prepare(
        'SELECT * FROM response_auths WHERE seller_peer_id = ? ORDER BY received_at DESC LIMIT ?',
      ),
    };
  }

  private _prepareInsertResponseAuthStatement(): Database.Statement {
    return this._db.prepare(`
      INSERT INTO response_auths (
        request_id, version, channel_id, buyer_peer_id, seller_peer_id,
        advertised_service, provider, status_code, request_hash, response_hash,
        response_started_at, response_completed_at, signature,
        received_at, verified, verification_error, request_preimage, response_preimage
      ) VALUES (
        @requestId, @version, @channelId, @buyerPeerId, @sellerPeerId,
        @advertisedService, @provider, @statusCode, @requestHash, @responseHash,
        @responseStartedAt, @responseCompletedAt, @signature,
        @receivedAt, @verified, @verificationError, @requestPreimage, @responsePreimage
      )
      ON CONFLICT(request_id) DO UPDATE SET
        version = excluded.version,
        channel_id = excluded.channel_id,
        buyer_peer_id = excluded.buyer_peer_id,
        seller_peer_id = excluded.seller_peer_id,
        advertised_service = excluded.advertised_service,
        provider = excluded.provider,
        status_code = excluded.status_code,
        request_hash = excluded.request_hash,
        response_hash = excluded.response_hash,
        response_started_at = excluded.response_started_at,
        response_completed_at = excluded.response_completed_at,
        signature = excluded.signature,
        received_at = excluded.received_at,
        verified = excluded.verified,
        verification_error = excluded.verification_error,
        request_preimage = excluded.request_preimage,
        response_preimage = excluded.response_preimage
    `);
  }

  insertResponseAuth(record: StoredResponseAuth): void {
    this._insertResponseAuth.run({
      requestId: record.requestId,
      version: record.version,
      channelId: record.channelId ?? null,
      buyerPeerId: record.buyerPeerId,
      sellerPeerId: record.sellerPeerId,
      advertisedService: record.advertisedService,
      provider: record.provider,
      statusCode: record.statusCode,
      requestHash: record.requestHash,
      responseHash: record.responseHash,
      responseStartedAt: record.responseStartedAt,
      responseCompletedAt: record.responseCompletedAt,
      signature: record.signature,
      receivedAt: record.receivedAt,
      verified: record.verified ? 1 : 0,
      verificationError: record.verificationError,
      requestPreimage: record.requestPreimage ? Buffer.from(record.requestPreimage) : null,
      responsePreimage: record.responsePreimage ? Buffer.from(record.responsePreimage) : null,
    });
  }

  getResponseAuth(requestId: string): StoredResponseAuth | null {
    const row = this._getResponseAuth.get(requestId) as ResponseAuthRow | undefined;
    return row ? rowToResponseAuth(row) : null;
  }

  listResponseAuthsBySeller(sellerPeerId: string, limit = 100): StoredResponseAuth[] {
    const rows = this._listResponseAuthsBySeller.all(sellerPeerId, Math.max(1, limit)) as ResponseAuthRow[];
    return rows.map(rowToResponseAuth);
  }

  close(): void {
    this._db.close();
  }
}

interface VerificationStorageStatements {
  insertResponseAuth: Database.Statement;
  getResponseAuth: Database.Statement;
  listResponseAuthsBySeller: Database.Statement;
}

interface ResponseAuthRow {
  request_id: string;
  version: number;
  channel_id: string | null;
  buyer_peer_id: string;
  seller_peer_id: string;
  advertised_service: string;
  provider: string;
  status_code: number;
  request_hash: string;
  response_hash: string;
  response_started_at: number;
  response_completed_at: number;
  signature: string;
  received_at: number;
  verified: number;
  verification_error: string | null;
  request_preimage: Buffer | null;
  response_preimage: Buffer | null;
}

function rowToResponseAuth(row: ResponseAuthRow): StoredResponseAuth {
  return {
    version: row.version as 1,
    requestId: row.request_id,
    ...(row.channel_id ? { channelId: row.channel_id } : {}),
    buyerPeerId: row.buyer_peer_id,
    sellerPeerId: row.seller_peer_id,
    advertisedService: row.advertised_service,
    provider: row.provider,
    statusCode: row.status_code,
    requestHash: row.request_hash,
    responseHash: row.response_hash,
    responseStartedAt: row.response_started_at,
    responseCompletedAt: row.response_completed_at,
    signature: row.signature,
    receivedAt: row.received_at,
    verified: row.verified === 1,
    verificationError: row.verification_error,
    requestPreimage: row.request_preimage ? new Uint8Array(row.request_preimage) : null,
    responsePreimage: row.response_preimage ? new Uint8Array(row.response_preimage) : null,
  };
}
