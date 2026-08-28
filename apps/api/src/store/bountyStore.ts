import type { Bounty, BountyStatus, ListBountiesQuery } from '@ai-bounties/shared'
import { persistFrom, type JsonPersist } from './persist.js'

interface StoreFile {
  bounties: Bounty[]
}

export class BountyStore {
  private backend: JsonPersist
  private bounties: Bounty[] = []

  constructor(dataDirOrPersist: string | JsonPersist) {
    this.backend = persistFrom(dataDirOrPersist, 'bounties.json')
  }

  async init(): Promise<void> {
    const raw = await this.backend.read()
    if (!raw) {
      this.bounties = []
      return
    }
    try {
      const parsed = JSON.parse(raw) as StoreFile
      this.bounties = parsed.bounties ?? []
    } catch {
      this.bounties = []
    }
  }

  private async persist(): Promise<void> {
    await this.backend.write(
      JSON.stringify({ bounties: this.bounties }, null, 2),
    )
  }

  list(query: ListBountiesQuery = {}): Bounty[] {
    let rows = [...this.bounties]
    if (query.status) rows = rows.filter((b) => b.status === query.status)
    if (query.category) {
      const c = query.category.toLowerCase()
      rows = rows.filter((b) => b.category.toLowerCase() === c)
    }
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const offset = query.offset ?? 0
    const limit = query.limit ?? 50
    return rows.slice(offset, offset + limit)
  }

  get(id: string): Bounty | undefined {
    return this.bounties.find((b) => b.id === id)
  }

  async create(bounty: Bounty): Promise<Bounty> {
    this.bounties.push(bounty)
    await this.persist()
    return bounty
  }

  async update(
    id: string,
    patch: Partial<Bounty>,
  ): Promise<Bounty | undefined> {
    const idx = this.bounties.findIndex((b) => b.id === id)
    if (idx < 0) return undefined
    const next: Bounty = {
      ...this.bounties[idx]!,
      ...patch,
      id,
      updatedAt: new Date().toISOString(),
    }
    this.bounties[idx] = next
    await this.persist()
    return next
  }

  count(status?: BountyStatus): number {
    if (!status) return this.bounties.length
    return this.bounties.filter((b) => b.status === status).length
  }
}
