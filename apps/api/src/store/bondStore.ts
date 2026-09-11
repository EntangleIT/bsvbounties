import type { BondRole, Network, PosterBond } from '@ai-bounties/shared'
import { bondRoleOf } from '@ai-bounties/shared'
import { persistFrom, type JsonPersist } from './persist.js'

interface StoreFile {
  bonds: PosterBond[]
}

export class BondStore {
  private backend: JsonPersist
  private bonds: PosterBond[] = []

  constructor(dataDirOrPersist: string | JsonPersist) {
    this.backend = persistFrom(dataDirOrPersist, 'bonds.json')
  }

  async init(): Promise<void> {
    const raw = await this.backend.read()
    if (!raw) {
      this.bonds = []
      return
    }
    try {
      const parsed = JSON.parse(raw) as StoreFile
      this.bonds = parsed.bonds ?? []
    } catch {
      this.bonds = []
    }
  }

  private async persist(): Promise<void> {
    await this.backend.write(JSON.stringify({ bonds: this.bonds }, null, 2))
  }

  getActive(
    controllerKey: string,
    role: BondRole = 'poster',
  ): PosterBond | undefined {
    return this.bonds.find(
      (b) =>
        b.controllerKey === controllerKey &&
        b.status === 'active' &&
        bondRoleOf(b) === role,
    )
  }

  list(controllerKey?: string, role?: BondRole): PosterBond[] {
    let rows = [...this.bonds]
    if (controllerKey) {
      rows = rows.filter((b) => b.controllerKey === controllerKey)
    }
    if (role) {
      rows = rows.filter((b) => bondRoleOf(b) === role)
    }
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  countActive(): number {
    return this.bonds.filter((b) => b.status === 'active').length
  }

  async deposit(opts: {
    controllerKey: string
    amountSats: number
    accountNumber?: number
    depositTxid?: string
    network: Network
    role?: BondRole
  }): Promise<PosterBond> {
    const role = opts.role ?? 'poster'
    const existing = this.getActive(opts.controllerKey, role)
    const now = new Date().toISOString()
    if (existing) {
      const next: PosterBond = {
        ...existing,
        amountSats: existing.amountSats + opts.amountSats,
        depositTxid: opts.depositTxid ?? existing.depositTxid,
        accountNumber: opts.accountNumber ?? existing.accountNumber,
        updatedAt: now,
      }
      const idx = this.bonds.findIndex(
        (b) =>
          b.controllerKey === opts.controllerKey &&
          b.status === 'active' &&
          bondRoleOf(b) === role,
      )
      this.bonds[idx] = next
      await this.persist()
      return next
    }

    const bond: PosterBond = {
      controllerKey: opts.controllerKey,
      accountNumber: opts.accountNumber,
      amountSats: opts.amountSats,
      status: 'active',
      role,
      depositTxid: opts.depositTxid,
      createdAt: now,
      updatedAt: now,
      network: opts.network,
    }
    this.bonds.push(bond)
    await this.persist()
    return bond
  }

  async release(
    controllerKey: string,
    releaseTxid?: string,
    role: BondRole = 'poster',
  ): Promise<PosterBond | undefined> {
    const b = this.getActive(controllerKey, role)
    if (!b) return undefined
    const next: PosterBond = {
      ...b,
      status: 'released',
      releaseTxid,
      amountSats: 0,
      updatedAt: new Date().toISOString(),
    }
    const idx = this.bonds.indexOf(b)
    this.bonds[idx] = next
    await this.persist()
    return next
  }

  async slash(
    controllerKey: string,
    reason: string,
    role: BondRole = 'poster',
    opts: { forfeitedTo?: string } = {},
  ): Promise<PosterBond | undefined> {
    const b = this.getActive(controllerKey, role)
    if (!b) return undefined
    const next: PosterBond = {
      ...b,
      status: 'slashed',
      slashReason: reason,
      ...(opts.forfeitedTo ? { forfeitedTo: opts.forfeitedTo } : {}),
      updatedAt: new Date().toISOString(),
    }
    const idx = this.bonds.indexOf(b)
    this.bonds[idx] = next
    await this.persist()
    return next
  }

  /**
   * True if controller has active bond >= minSats (0 = any active bond).
   */
  meetsMinimum(
    controllerKey: string,
    minSats: number,
    role: BondRole = 'poster',
  ): boolean {
    const b = this.getActive(controllerKey, role)
    if (!b) return false
    if (minSats <= 0) return true
    return b.amountSats >= minSats
  }
}
