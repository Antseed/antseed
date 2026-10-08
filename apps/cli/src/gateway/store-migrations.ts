/**
 * Schema migrations, applied in order and tracked in `user_version`.
 * Append-only: never edit a migration that has shipped.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_hint TEXT NOT NULL,
    buyer_identity TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'created',
    status TEXT NOT NULL DEFAULT 'active',
    daily_limit_usdc INTEGER,
    monthly_limit_usdc INTEGER,
    total_limit_usdc INTEGER,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    last_used_at INTEGER
  );
  CREATE TABLE gateway_requests (
    tag TEXT PRIMARY KEY,
    key_id TEXT NOT NULL,
    buyer_identity TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    model TEXT,
    status INTEGER,
    buyer_request_id TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX gateway_requests_key_time ON gateway_requests(key_id, started_at);
  CREATE TABLE ledger_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('spend', 'credit')),
    key_id TEXT NOT NULL,
    buyer_identity TEXT NOT NULL,
    amount_usdc INTEGER NOT NULL,
    external_ref TEXT NOT NULL UNIQUE,
    request_tag TEXT,
    seller_peer_id TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX ledger_entries_key_time ON ledger_entries(key_id, kind, created_at);
  `,
  `
  ALTER TABLE api_keys ADD COLUMN topup_enabled INTEGER NOT NULL DEFAULT 0;
  `,
  // v3 (not shipped yet, so console schema changes still go here rather
  // than into a v4), the console: organization (workspaces, members, invites, presets,
  // peer lists, management tokens, settings, audit log). Every existing key
  // moves into a workspace paying with the key's identity, so nothing
  // changes wallet. Keys get an owner layer (limits and policy the key's
  // owner sets on top of the admins'). Ledger rows carry the workspace,
  // member, model and end user they were spent under (request-time
  // attribution, so moving a key does not move its history); spend is
  // rolled up per key, member and workspace (lifetime and per UTC day) by a
  // trigger, so admission never scans the ledger. Request counts of pruned
  // request-log rows are kept in hourly rollups.
  `
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    buyer_identity TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    daily_limit_usdc INTEGER,
    weekly_limit_usdc INTEGER,
    monthly_limit_usdc INTEGER,
    total_limit_usdc INTEGER,
    routing_policy TEXT,
    org_routing_policy TEXT,
    wallet_address TEXT,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE TABLE members (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    email TEXT,
    org_role TEXT NOT NULL CHECK (org_role IN ('owner', 'admin', 'member')),
    status TEXT NOT NULL CHECK (status IN ('active', 'invited', 'disabled')),
    daily_limit_usdc INTEGER,
    weekly_limit_usdc INTEGER,
    monthly_limit_usdc INTEGER,
    total_limit_usdc INTEGER,
    routing_policy TEXT,
    max_keys INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX members_email ON members(lower(email)) WHERE email IS NOT NULL;
  CREATE TABLE workspace_members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    PRIMARY KEY (workspace_id, member_id)
  );
  CREATE INDEX workspace_members_member ON workspace_members(member_id);
  CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    email TEXT,
    org_role TEXT NOT NULL,
    workspace_roles TEXT NOT NULL DEFAULT '[]',
    created_by TEXT,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  );
  INSERT INTO workspaces (id, name, buyer_identity, is_default, created_at)
    VALUES ('ws_default', 'Default', 'default', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  INSERT INTO workspaces (id, name, buyer_identity, is_default, created_at)
    SELECT 'ws_' || buyer_identity, buyer_identity, buyer_identity, 0, MIN(created_at)
    FROM api_keys WHERE buyer_identity <> 'default' GROUP BY buyer_identity;
  ALTER TABLE api_keys ADD COLUMN workspace_id TEXT;
  ALTER TABLE api_keys ADD COLUMN owner_member_id TEXT;
  ALTER TABLE api_keys ADD COLUMN routing_policy TEXT;
  ALTER TABLE api_keys ADD COLUMN weekly_limit_usdc INTEGER;
  ALTER TABLE api_keys ADD COLUMN owner_routing_policy TEXT;
  ALTER TABLE api_keys ADD COLUMN owner_daily_limit_usdc INTEGER;
  ALTER TABLE api_keys ADD COLUMN owner_weekly_limit_usdc INTEGER;
  ALTER TABLE api_keys ADD COLUMN owner_monthly_limit_usdc INTEGER;
  ALTER TABLE api_keys ADD COLUMN owner_total_limit_usdc INTEGER;
  UPDATE api_keys SET workspace_id = CASE WHEN buyer_identity = 'default' THEN 'ws_default' ELSE 'ws_' || buyer_identity END;
  CREATE INDEX api_keys_workspace ON api_keys(workspace_id);
  CREATE INDEX api_keys_owner ON api_keys(owner_member_id);
  ALTER TABLE gateway_requests ADD COLUMN seller_peer_id TEXT;
  ALTER TABLE gateway_requests ADD COLUMN latency_ms INTEGER;
  ALTER TABLE gateway_requests ADD COLUMN end_user TEXT;
  ALTER TABLE gateway_requests ADD COLUMN workspace_id TEXT;
  ALTER TABLE gateway_requests ADD COLUMN member_id TEXT;
  ALTER TABLE gateway_requests ADD COLUMN request_body TEXT;
  ALTER TABLE gateway_requests ADD COLUMN response_body TEXT;
  ALTER TABLE gateway_requests ADD COLUMN error_code TEXT;
  ALTER TABLE gateway_requests ADD COLUMN error_message TEXT;
  ALTER TABLE gateway_requests ADD COLUMN usage_input_tokens INTEGER;
  ALTER TABLE gateway_requests ADD COLUMN usage_cached_input_tokens INTEGER;
  ALTER TABLE gateway_requests ADD COLUMN usage_output_tokens INTEGER;
  UPDATE gateway_requests SET workspace_id = (SELECT workspace_id FROM api_keys WHERE api_keys.id = gateway_requests.key_id);
  CREATE INDEX gateway_requests_time ON gateway_requests(started_at);
  CREATE INDEX gateway_requests_workspace_time ON gateway_requests(workspace_id, started_at);
  CREATE INDEX gateway_requests_member_time ON gateway_requests(member_id, started_at);
  ALTER TABLE ledger_entries ADD COLUMN workspace_id TEXT;
  ALTER TABLE ledger_entries ADD COLUMN member_id TEXT;
  ALTER TABLE ledger_entries ADD COLUMN model TEXT;
  ALTER TABLE ledger_entries ADD COLUMN end_user TEXT;
  UPDATE ledger_entries SET
    workspace_id = CASE WHEN EXISTS (SELECT 1 FROM gateway_requests r WHERE r.tag = ledger_entries.request_tag)
      THEN (SELECT COALESCE(r.workspace_id, k.workspace_id) FROM gateway_requests r LEFT JOIN api_keys k ON k.id = r.key_id WHERE r.tag = ledger_entries.request_tag)
      ELSE (SELECT k.workspace_id FROM api_keys k WHERE k.id = ledger_entries.key_id) END,
    member_id = CASE WHEN EXISTS (SELECT 1 FROM gateway_requests r WHERE r.tag = ledger_entries.request_tag)
      THEN (SELECT r.member_id FROM gateway_requests r WHERE r.tag = ledger_entries.request_tag)
      ELSE (SELECT k.owner_member_id FROM api_keys k WHERE k.id = ledger_entries.key_id) END,
    model = (SELECT r.model FROM gateway_requests r WHERE r.tag = ledger_entries.request_tag),
    end_user = (SELECT r.end_user FROM gateway_requests r WHERE r.tag = ledger_entries.request_tag);
  DROP INDEX ledger_entries_key_time;
  CREATE INDEX ledger_entries_key_time ON ledger_entries(key_id, kind, created_at, amount_usdc);
  CREATE INDEX ledger_entries_member_time ON ledger_entries(member_id, kind, created_at, amount_usdc);
  CREATE INDEX ledger_entries_workspace_time ON ledger_entries(workspace_id, kind, created_at, amount_usdc);
  CREATE INDEX ledger_entries_request ON ledger_entries(request_tag);
  CREATE INDEX ledger_entries_time ON ledger_entries(created_at);
  CREATE TABLE spend_totals (
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('key', 'member', 'workspace')),
    scope_id TEXT NOT NULL,
    total_usdc INTEGER NOT NULL,
    PRIMARY KEY (scope_kind, scope_id)
  ) WITHOUT ROWID;
  CREATE TABLE spend_daily (
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('key', 'member', 'workspace')),
    scope_id TEXT NOT NULL,
    day_start INTEGER NOT NULL,
    amount_usdc INTEGER NOT NULL,
    PRIMARY KEY (scope_kind, scope_id, day_start)
  ) WITHOUT ROWID;
  INSERT INTO spend_daily (scope_kind, scope_id, day_start, amount_usdc)
    SELECT 'key', key_id, (created_at / 86400000) * 86400000, -SUM(amount_usdc) FROM ledger_entries WHERE kind = 'spend' GROUP BY 2, 3;
  INSERT INTO spend_daily (scope_kind, scope_id, day_start, amount_usdc)
    SELECT 'member', member_id, (created_at / 86400000) * 86400000, -SUM(amount_usdc) FROM ledger_entries
    WHERE kind = 'spend' AND member_id IS NOT NULL GROUP BY 2, 3;
  INSERT INTO spend_daily (scope_kind, scope_id, day_start, amount_usdc)
    SELECT 'workspace', workspace_id, (created_at / 86400000) * 86400000, -SUM(amount_usdc) FROM ledger_entries
    WHERE kind = 'spend' AND workspace_id IS NOT NULL GROUP BY 2, 3;
  INSERT INTO spend_totals (scope_kind, scope_id, total_usdc)
    SELECT scope_kind, scope_id, SUM(amount_usdc) FROM spend_daily GROUP BY scope_kind, scope_id;
  CREATE TRIGGER ledger_entries_spend_rollup AFTER INSERT ON ledger_entries WHEN NEW.kind = 'spend' BEGIN
    INSERT INTO spend_totals (scope_kind, scope_id, total_usdc) VALUES ('key', NEW.key_id, -NEW.amount_usdc)
      ON CONFLICT (scope_kind, scope_id) DO UPDATE SET total_usdc = total_usdc + excluded.total_usdc;
    INSERT INTO spend_totals (scope_kind, scope_id, total_usdc) SELECT 'member', NEW.member_id, -NEW.amount_usdc WHERE NEW.member_id IS NOT NULL
      ON CONFLICT (scope_kind, scope_id) DO UPDATE SET total_usdc = total_usdc + excluded.total_usdc;
    INSERT INTO spend_totals (scope_kind, scope_id, total_usdc) SELECT 'workspace', NEW.workspace_id, -NEW.amount_usdc WHERE NEW.workspace_id IS NOT NULL
      ON CONFLICT (scope_kind, scope_id) DO UPDATE SET total_usdc = total_usdc + excluded.total_usdc;
    INSERT INTO spend_daily (scope_kind, scope_id, day_start, amount_usdc) VALUES ('key', NEW.key_id, (NEW.created_at / 86400000) * 86400000, -NEW.amount_usdc)
      ON CONFLICT (scope_kind, scope_id, day_start) DO UPDATE SET amount_usdc = amount_usdc + excluded.amount_usdc;
    INSERT INTO spend_daily (scope_kind, scope_id, day_start, amount_usdc)
      SELECT 'member', NEW.member_id, (NEW.created_at / 86400000) * 86400000, -NEW.amount_usdc WHERE NEW.member_id IS NOT NULL
      ON CONFLICT (scope_kind, scope_id, day_start) DO UPDATE SET amount_usdc = amount_usdc + excluded.amount_usdc;
    INSERT INTO spend_daily (scope_kind, scope_id, day_start, amount_usdc)
      SELECT 'workspace', NEW.workspace_id, (NEW.created_at / 86400000) * 86400000, -NEW.amount_usdc WHERE NEW.workspace_id IS NOT NULL
      ON CONFLICT (scope_kind, scope_id, day_start) DO UPDATE SET amount_usdc = amount_usdc + excluded.amount_usdc;
  END;
  CREATE TABLE request_rollups (
    hour_start INTEGER NOT NULL,
    key_id TEXT NOT NULL,
    workspace_id TEXT,
    member_id TEXT,
    model TEXT,
    seller_peer_id TEXT,
    end_user TEXT,
    requests INTEGER NOT NULL,
    failed_requests INTEGER NOT NULL
  );
  CREATE INDEX request_rollups_time ON request_rollups(hour_start);
  CREATE INDEX request_rollups_key ON request_rollups(key_id, hour_start);
  CREATE TABLE peer_lists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    peer_ids TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE presets (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    workspace_id TEXT,
    model TEXT NOT NULL,
    routing_policy TEXT,
    system_prompt TEXT,
    params TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX presets_slug ON presets(slug, COALESCE(workspace_id, ''));
  CREATE TABLE admin_tokens (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    hint TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('admin', 'read')),
    created_by TEXT,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE audit_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    at INTEGER NOT NULL,
    actor_kind TEXT NOT NULL,
    actor_id TEXT,
    actor_label TEXT,
    action TEXT NOT NULL,
    target_kind TEXT,
    target_id TEXT,
    target_label TEXT,
    details TEXT NOT NULL DEFAULT '{}',
    ip TEXT
  );
  CREATE INDEX audit_log_actor ON audit_log(actor_id, seq);
  CREATE INDEX audit_log_action ON audit_log(action, seq);
  CREATE TABLE console_recovery_tokens (
    token_hash TEXT PRIMARY KEY,
    member_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  `,
]
