import type {
  Account,
  AccountKind,
  AccountStats,
  ListAccountsQuery,
  Network,
} from '@ai-bounties/shared'
import { EMPTY_ACCOUNT_STATS, normalizeAccount } from '@ai-bounties/shared'
import { persistFrom, type JsonPersist } from './persist.js'

interface StoreFile {
  nextNumber: number
  accounts: Account[]
}

export class AccountStore {
  private backend: JsonPersist
  private nextNumber = 1
  private accounts: Account[] = []

  constructor(dataDirOrPersist: string | JsonPersist) {
    this.backend = persistFrom(dataDirOrPersist, 'accounts.json')
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
