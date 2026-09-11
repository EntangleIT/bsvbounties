/**
 * bsvbounties D1 mirror (Phase C) — isolates the hot account reads from the
 * KV JSON files without changing the KV source of truth yet.
 *
 * - Writes: AccountStore mirrors every mint/update (single-row UPSERT,
 *   best-effort, never fails the request).
 * - Reads: leaderboard prefers D1 (narrow rows, no 25MB KV value), with
 *   automatic fallback to the in-memory KV snapshot.
 * - Provisioning: `wrangler d1 create bsvbounties`, apply schema.sql, then
 *   uncomment the d1_databases block in wrangler.jsonc (binding BSVB_D1).
 */
import type { Account } from '@ai-bounties/shared'

export interface D1StmtLike {
  bind(...params: unknown[]): D1StmtLike
  first<T>(): Promise<T | null>
  all<T>(): Promise<{ results: T[] }>
  run(): Promise<unknown>
}

export interface D1Like {
  prepare(query: string): D1StmtLike
}

const TABLES = `
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
`

let ensured = new WeakMap<object, boolean>()

export async function ensureBbTables(db: D1Like): Promise<void> {
  const d = db as unknown as object
  if (ensured.get(d)) return
  for (const stmt of TABLES.split(';')) {
    const sql = stmt.trim()
    if (sql) await db.prepare(sql).run()
  }
  ensured.set(d, true)
}

/** Single-row UPSERT. Throws on D1 error — callers must catch (mirror). */
export async function mirrorAccount(db: D1Like, account: Account): Promise<void> {
  await ensureBbTables(db)
  await db
    .prepare(
      `INSERT INTO bb_accounts (number, controller_key, kind, for_sale, stats_json, twetch_sub, body_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(number) DO UPDATE SET
         controller_key = excluded.controller_key,
         kind = excluded.kind,
         for_sale = excluded.for_sale,
         stats_json = excluded.stats_json,
         twetch_sub = excluded.twetch_sub,
         body_json = excluded.body_json,
         updated_at = excluded.updated_at`,
    )
    .bind(
      account.number,
      account.controllerKey ?? '',
      account.kind ?? 'human',
      account.listPriceSats != null && account.listPriceSats > 0 ? 1 : 0,
      JSON.stringify(account.stats ?? {}),
      account.twetch?.sub ?? null,
      JSON.stringify(account),
      new Date().toISOString(),
    )
    .run()
}

export async function readAccountsD1(db: D1Like, limit = 1000): Promise<Account[]> {
  await ensureBbTables(db)
  const res = await db
    .prepare('SELECT body_json AS body FROM bb_accounts LIMIT ?')
    .bind(Math.min(Math.max(limit, 1), 5000))
    .all<{ body: string }>()
  const out: Account[] = []
  for (const row of res.results ?? []) {
    try {
      out.push(JSON.parse(row.body) as Account)
    } catch {
      /* skip corrupt mirror rows — KV remains source of truth */
    }
  }
  return out
}

export async function countAccountsD1(db: D1Like): Promise<number> {
  await ensureBbTables(db)
  const row = await db.prepare('SELECT COUNT(*) AS n FROM bb_accounts').first<{ n: number }>()
  return Number(row?.n ?? 0)
}
