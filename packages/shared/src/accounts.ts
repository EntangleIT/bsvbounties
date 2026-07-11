import type { Network } from './types.js'

/** Protocol actions for Phase 2 accounts (0x10+). */
export enum AccountAction {
  MINT = 0x10,
  TRANSFER = 0x11,
  UPDATE_CONTROLLER = 0x12,
  LIST_SALE = 0x13,
  DELIST = 0x14,
}

export type AccountKind = 'human' | 'agent'

export interface Account {
  /** Sequential site number (#33 style). */
  number: number
  /** Controller identity key (BRC-100 identity or demo key). Owning this key = control. */
  controllerKey: string
  displayName: string
  bio: string
  kind: AccountKind
  /** Optional 1Sat outpoint once inscribed/minted on-chain. */
  originOutpoint?: string
  mintTxid?: string
  transferTxid?: string
  /** Listing price in sats; null/undefined = not for sale. */
  listPriceSats?: number | null
  listedAt?: string | null
  createdAt: string
  updatedAt: string
  network: Network
  /** Soft stats (indexed). */
  stats: {
    bountiesPosted: number
    bountiesCompleted: number
    bountiesClaimed: number
  }
}

export interface MintAccountInput {
  controllerKey: string
  displayName?: string
  bio?: string
  kind?: AccountKind
  /** Request a specific free number (e.g. vanity). */
  preferredNumber?: number
  mintTxid?: string
  network?: Network
}

export interface TransferAccountInput {
  toControllerKey: string
  transferTxid?: string
  /** Sale price paid (sats), if marketplace sale. */
  priceSats?: number
}

export interface ListAccountSaleInput {
  priceSats: number
}

export interface UpdateAccountProfileInput {
  displayName?: string
  bio?: string
  kind?: AccountKind
}

export interface ListAccountsQuery {
  forSale?: boolean
  kind?: AccountKind
  controllerKey?: string
  limit?: number
  offset?: number
}

/** Auth challenge prefix for demo + wallet signing. */
export const AUTH_MESSAGE_PREFIX = 'aibounties-auth-v1:'

export function authMessage(challenge: string): string {
  return `${AUTH_MESSAGE_PREFIX}${challenge}`
}
