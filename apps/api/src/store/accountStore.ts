import type {
  Account,
  AccountKind,
  AccountStats,
  ListAccountsQuery,
  Network,
} from '@ai-bounties/shared'
import { EMPTY_ACCOUNT_STATS, normalizeAccount } from '@ai-bounties/shared'
import { persistFrom, type JsonPersist } from './persist.js'
import { countAccountsD1, mirrorAccount, readAccountsD1, type D1Like } from './d1.js'
interface StoreFile {
  nextNumber: number
  accounts: Account[]
}

export class AccountStore {
  private backend: JsonPersist
  private nextNumber = 1
  private accounts: Account[] = []
  /** Optional D1 write-mirror (Phase C). Null until provisioned. */
  private d1: D1Like | null = null

  constructor(dataDirOrPersist: string | JsonPersist) {
    this.backend = persistFrom(dataDirOrPersist, 'accounts.json')
  }

  /** Attach the bsvbounties D1 for mirroring. Safe to call with undefined. */
  attachD1(db: D1Like | null | undefined): void {
    this.d1 = db ?? null
  }

  get d1Attached(): boolean {
    return this.d1 !== null
  }

  private mirror(account: Account): Promise<void> {
    if (!this.d1) return Promise.resolve()
    return mirrorAccount(this.d1, account).catch(() => {
      /* mirror is best-effort — KV remains source of truth */
    })
  }

  async init(): Promise<void> {
    const raw = await this.backend.read()
    if (!raw) {
      this.accounts = []
      this.nextNumber = 1
      return
    }
    try {
      const parsed = JSON.parse(raw) as StoreFile
      this.accounts = parsed.accounts ?? []
      this.nextNumber = parsed.nextNumber ?? this.computeNext()
    } catch {
      this.accounts = []
      this.nextNumber = 1
    }
  }

  private computeNext(): number {
    if (this.accounts.length === 0) return 1
    return Math.max(...this.accounts.map((a) => a.number)) + 1
  }

  private async persist(): Promise<void> {
    await this.backend.write(
      JSON.stringify(
        { nextNumber: this.nextNumber, accounts: this.accounts },
        null,
        2,
      ),
    )
  }

  count(): number {
    return this.accounts.length
  }

  listForSaleCount(): number {
    return this.accounts.filter(
      (a) => a.listPriceSats != null && a.listPriceSats > 0,
    ).length
  }

  getByNumber(n: number): Account | undefined {
    const a = this.accounts.find((row) => row.number === n)
    return a ? normalizeAccount(a) : undefined
  }

  getByController(controllerKey: string): Account[] {
    return this.accounts
      .filter((a) => a.controllerKey === controllerKey)
      .map(normalizeAccount)
  }

  /** The account verified by a Twetch `sub`, if any (subs are unique). */
  getByTwetchSub(sub: string): Account | undefined {
    const a = this.accounts.find((row) => row.twetch?.sub === sub)
    return a ? normalizeAccount(a) : undefined
  }

  isNumberTaken(n: number): boolean {
    return this.accounts.some((a) => a.number === n)
  }

  list(query: ListAccountsQuery = {}): Account[] {
    let rows = [...this.accounts]
    if (query.forSale) {
      rows = rows.filter((a) => a.listPriceSats != null && a.listPriceSats > 0)
    }
    if (query.kind) rows = rows.filter((a) => a.kind === query.kind)
    if (query.controllerKey) {
      rows = rows.filter((a) => a.controllerKey === query.controllerKey)
    }
    rows = rows.map(normalizeAccount)
    rows.sort((a, b) => a.number - b.number)
    const offset = query.offset ?? 0
    const limit = query.limit ?? 100
    return rows.slice(offset, offset + limit)
  }

  /**
   * Leaderboard source rows, D1-preferred with KV fallback.
   * Returns normalized accounts (unranked); callers apply reputationOf + sort.
   * Throws only when neither source yields rows AND d1 is attached — callers
   * fall back to list() on any error.
   */
  async leaderboardRows(limit = 1000): Promise<{ rows: Account[]; source: 'd1' | 'kv' }> {
    if (this.d1) {
      try {
        const rows = (await readAccountsD1(this.d1, limit)).map(normalizeAccount)
        if (rows.length > 0 || (await countAccountsD1(this.d1)) === 0) {
          return { rows, source: 'd1' }
        }
      } catch {
        /* fall through to KV snapshot */
      }
    }
    return { rows: this.list({ limit }), source: 'kv' }
  }

  async mint(opts: {
    controllerKey: string
    displayName: string
    bio: string
    kind: AccountKind
    preferredNumber?: number
    mintTxid?: string
    network: Network
    skills?: string[]
    capabilities?: string[]
    callback?: string
  }): Promise<Account> {
    let number: number
    if (opts.preferredNumber != null) {
      if (opts.preferredNumber < 1) throw new Error('invalid_number')
      if (this.isNumberTaken(opts.preferredNumber)) {
        throw new Error('number_taken')
      }
      number = opts.preferredNumber
      if (number >= this.nextNumber) this.nextNumber = number + 1
    } else {
      while (this.isNumberTaken(this.nextNumber)) this.nextNumber++
      number = this.nextNumber
      this.nextNumber++
    }

    const now = new Date().toISOString()
    const account: Account = {
      number,
      controllerKey: opts.controllerKey,
      displayName: opts.displayName || `#${number}`,
      bio: opts.bio ?? '',
      kind: opts.kind,
      mintTxid: opts.mintTxid,
      listPriceSats: null,
      listedAt: null,
      createdAt: now,
      updatedAt: now,
      network: opts.network,
      skills: opts.skills ?? [],
      capabilities: opts.capabilities ?? [],
      callback: opts.callback,
      stats: { ...EMPTY_ACCOUNT_STATS },
    }
    this.accounts.push(account)
    await this.persist()
    await this.mirror(account)
    return account
  }

  async update(
    number: number,
    patch: Partial<Account>,
  ): Promise<Account | undefined> {
    const idx = this.accounts.findIndex((a) => a.number === number)
    if (idx < 0) return undefined
    const next: Account = {
      ...this.accounts[idx]!,
      ...patch,
      number,
      updatedAt: new Date().toISOString(),
    }
    this.accounts[idx] = next
    await this.persist()
    await this.mirror(next)
    return next
  }

  async transfer(
    number: number,
    toControllerKey: string,
    opts?: { transferTxid?: string; clearListing?: boolean },
  ): Promise<Account | undefined> {
    return this.update(number, {
      controllerKey: toControllerKey,
      transferTxid: opts?.transferTxid,
      listPriceSats: opts?.clearListing === false ? undefined : null,
      listedAt: opts?.clearListing === false ? undefined : null,
      // Identity does not transfer: the buyer links their own Twetch.
      // Reputation stats stay with the number.
      twetch: undefined,
    })
  }

  async bumpStat(
    number: number,
    stat: Exclude<keyof AccountStats, 'submitDurationsMs'>,
    delta = 1,
  ): Promise<void> {
    const a = this.getByNumber(number)
    if (!a) return
    await this.update(number, {
      stats: { ...a.stats, [stat]: a.stats[stat] + delta },
    })
  }

  async recordSubmitDuration(number: number, durationMs: number): Promise<void> {
    const a = this.getByNumber(number)
    if (!a) return
    const next = [...a.stats.submitDurationsMs, durationMs].slice(-32)
    await this.update(number, {
      stats: { ...a.stats, submitDurationsMs: next },
    })
  }
}
