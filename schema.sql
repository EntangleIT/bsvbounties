-- bsvbounties D1 (Phase C) — isolates account reads from the KV JSON files.
-- Database name: bsvbounties (per CEO decision).
--
-- Provision:
--   wrangler d1 create bsvbounties
--   wrangler d1 execute bsvbounties --file=schema.sql --remote   (from apps/api or repo root)
--   uncomment the d1_databases block in wrangler.jsonc (binding BSVB_D1)
--   node scripts/backfill-d1.mjs ./data/accounts.json > backfill.sql
--   wrangler d1 execute bsvbounties --file=backfill.sql --remote
--
-- KV JSON files remain the source of truth until the cutover release;
-- the worker dual-writes every account mutation to bb_accounts.

CREATE TABLE IF NOT EXISTS bb_accounts (
  number INTEGER PRIMARY KEY,
  controller_key TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'human',
  for_sale INTEGER NOT NULL DEFAULT 0,
  stats_json TEXT NOT NULL DEFAULT '{}',
  twetch_sub TEXT,
  body_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bb_accounts_controller ON bb_accounts(controller_key);
CREATE INDEX IF NOT EXISTS idx_bb_accounts_forsale ON bb_accounts(for_sale);
CREATE TABLE IF NOT EXISTS bb_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
