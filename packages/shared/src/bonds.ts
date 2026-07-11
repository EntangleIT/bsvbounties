import type { Network } from './types.js'

/** Poster bond: standing deposit that unlocks posting rights / spam resistance. */
export interface PosterBond {
  controllerKey: string
  /** Account number if bonded as a numbered identity. */
  accountNumber?: number
  amountSats: number
  status: 'active' | 'released' | 'slashed'
  depositTxid?: string
  releaseTxid?: string
  slashReason?: string
  createdAt: string
  updatedAt: string
  network: Network
}

export interface DepositBondInput {
  controllerKey: string
  amountSats: number
  accountNumber?: number
  depositTxid?: string
  network?: Network
}
