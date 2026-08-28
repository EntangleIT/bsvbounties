import type { Network } from './types.js'

export type BondRole = 'poster' | 'worker'

/** Standing deposit: poster (post gate) or worker (claim gate). */
export interface PosterBond {
  controllerKey: string
  /** Account number if bonded as a numbered identity. */
  accountNumber?: number
  amountSats: number
  status: 'active' | 'released' | 'slashed'
  /** Default poster for records minted before Phase 6. */
  role?: BondRole
  depositTxid?: string
  releaseTxid?: string
  slashReason?: string
  createdAt: string
  updatedAt: string
  network: Network
}

export type Bond = PosterBond

export interface DepositBondInput {
  controllerKey: string
  amountSats: number
  accountNumber?: number
  depositTxid?: string
  network?: Network
  role?: BondRole
}

export function bondRoleOf(bond: PosterBond): BondRole {
  return bond.role ?? 'poster'
}
