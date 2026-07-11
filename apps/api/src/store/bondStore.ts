import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Network, PosterBond } from '@ai-bounties/shared'

interface StoreFile {
  bonds: PosterBond[]
}

export class BondStore {
  private filePath: string
  private bonds: PosterBond[] = []
  private loaded = false

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'bonds.json')
  }

  async init(): Promise<void> {
    if (this.loaded) return
    await mkdir(path.dirname(this.filePath), { recursive: true })
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as StoreFile
      this.bonds = parsed.bonds ?? []
    } catch {
      this.bonds = []
      await this.persist()
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    await writeFile(
      this.filePath,
      JSON.stringify({ bonds: this.bonds }, null, 2),
      'utf8',
    )
  }

  getActive(controllerKey: string): PosterBond | undefined {
    return this.bonds.find(
      (b) => b.controllerKey === controllerKey && b.status === 'active',
    )
  }

  list(controllerKey?: string): PosterBond[] {
    let rows = [...this.bonds]
    if (controllerKey) {
      rows = rows.filter((b) => b.controllerKey === controllerKey)
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
  }): Promise<PosterBond> {
    const existing = this.getActive(opts.controllerKey)
    const now = new Date().toISOString()
    if (existing) {
      // Top up
      const next: PosterBond = {
        ...existing,
        amountSats: existing.amountSats + opts.amountSats,
        depositTxid: opts.depositTxid ?? existing.depositTxid,
        accountNumber: opts.accountNumber ?? existing.accountNumber,
        updatedAt: now,
      }
      const idx = this.bonds.findIndex(
        (b) =>
          b.controllerKey === opts.controllerKey && b.status === 'active',
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
      depositTxid: opts.depositTxid,
      createdAt: now,
      updatedAt: now,
      network: opts.network,
    }
    this.bonds.push(bond)
    await this.persist()
    return bond
  }

  async release(controllerKey: string, releaseTxid?: string): Promise<PosterBond | undefined> {
    const b = this.getActive(controllerKey)
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
  ): Promise<PosterBond | undefined> {
    const b = this.getActive(controllerKey)
    if (!b) return undefined
    const next: PosterBond = {
      ...b,
      status: 'slashed',
      slashReason: reason,
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
  meetsMinimum(controllerKey: string, minSats: number): boolean {
    const b = this.getActive(controllerKey)
    if (!b) return false
    if (minSats <= 0) return true
    return b.amountSats >= minSats
  }
}
