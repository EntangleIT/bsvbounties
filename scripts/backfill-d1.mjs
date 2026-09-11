#!/usr/bin/env node
/**
 * Backfill bsvbounties D1 from the KV/file snapshot (Phase C).
 * Usage: node scripts/backfill-d1.mjs [./data/accounts.json] > backfill.sql
 * Emits INSERT OR REPLACE statements for bb_accounts. Idempotent.
 */
import { readFileSync } from 'node:fs'

const src = process.argv[2] ?? './data/accounts.json'
const raw = readFileSync(src, 'utf8')
const parsed = JSON.parse(raw)
const accounts = parsed.accounts ?? []

const esc = (s) => `'${String(s).replace(/'/g, "''")}'`
for (const a of accounts) {
  const stats = JSON.stringify(a.stats ?? {})
  const body = JSON.stringify(a)
  const forSale = a.listPriceSats != null && a.listPriceSats > 0 ? 1 : 0
  console.log(
    `INSERT OR REPLACE INTO bb_accounts (number, controller_key, kind, for_sale, stats_json, twetch_sub, body_json, updated_at) VALUES (${Number(a.number)}, ${esc(a.controllerKey ?? '')}, ${esc(a.kind ?? 'human')}, ${forSale}, ${esc(stats)}, ${a.twetch?.sub ? esc(a.twetch.sub) : 'NULL'}, ${esc(body)}, ${esc(a.updatedAt ?? new Date().toISOString())});`,
  )
}
console.error(`backfill: ${accounts.length} account rows emitted`)
