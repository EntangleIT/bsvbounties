import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  Account,
  AccountKind,
  ListAccountsQuery,
  Network,
} from '@ai-bounties/shared'

interface StoreFile {
  nextNumber: number
  accounts: Account[]
}

export class AccountStore {
  private filePath: string
  private nextNumber = 1
  private accounts: Account[] = []
  private loaded = false

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'accounts.json')
  }

  async init(): Promise<void> {
    if (this.loaded) return
    await mkdir(path.dirname(this.filePath), { recursive: true })
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as StoreFile
      this.accounts = parsed.accounts ?? []
      this.nextNumber = parsed.nextNumber ?? this.computeNext()
    } catch {
      this.accounts = []
      this.nextNumber = 1
      await this.persist()
    }
    this.loaded = true
  }

  private computeNext(): number {
    if (this.accounts.length === 0) return 1
    return Math.max(...this.accounts.map((a) => a.number)) + 1
  }

  private async persist(): Promise<void> {
    await writeFile(
      this.filePath,
      JSON.stringify(
        { nextNumber: this.nextNumber, accounts: this.accounts },
        null,
        2,
      ),
      'utf8',
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
    return this.accounts.find((a) => a.number === n)
  }

  getByController(controllerKey: string): Account[] {
    return this.accounts.filter((a) => a.controllerKey === controllerKey)
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
      stats: {
        bountiesPosted: 0,
        bountiesCompleted: 0,
        bountiesClaimed: 0,
      },
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
    stat: keyof Account['stats'],
    delta = 1,
  ): Promise<void> {
    const a = this.getByNumber(number)
    if (!a) return
    await this.update(number, {
      stats: { ...a.stats, [stat]: a.stats[stat] + delta },
    })
  }
}
