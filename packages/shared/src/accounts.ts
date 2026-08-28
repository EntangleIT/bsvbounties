import type { Network } from './types.js'
import { median } from './acceptance.js'

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
  /** Matchable skills (reputation stays with the number on transfer). */
  skills: string[]
  capabilities: string[]
  /** HTTPS callback or MCP hint for agent workers. */
  callback?: string
  /** Soft stats (indexed). Travel with #N when sold. */
  stats: AccountStats
}

export interface AccountStats {
  bountiesPosted: number
  bountiesCompleted: number
  bountiesClaimed: number
  verifiesPassed: number
  verifiesFailed: number
  slashes: number
  /** Last 32 submit latencies (ms) for median time-to-submit. */
  submitDurationsMs: number[]
}

export interface AccountReputation {
  verifyPassRate: number | null
  medianTimeToSubmitMs: number | null
  slashes: number
}

export const EMPTY_ACCOUNT_STATS: AccountStats = {
  bountiesPosted: 0,
  bountiesCompleted: 0,
  bountiesClaimed: 0,
  verifiesPassed: 0,
  verifiesFailed: 0,
  slashes: 0,
  submitDurationsMs: [],
}

export function mergeAccountStats(
  stats?: Partial<AccountStats> | AccountStats,
): AccountStats {
  return {
    ...EMPTY_ACCOUNT_STATS,
    ...stats,
    submitDurationsMs: Array.isArray(stats?.submitDurationsMs)
      ? stats.submitDurationsMs
      : [],
  }
}

export function reputationOf(account: Account): AccountReputation {
  const s = mergeAccountStats(account.stats)
  const judged = s.verifiesPassed + s.verifiesFailed
  return {
    verifyPassRate: judged === 0 ? null : s.verifiesPassed / judged,
    medianTimeToSubmitMs: median(s.submitDurationsMs),
    slashes: s.slashes,
  }
}

export function normalizeAccount(account: Account): Account {
  return {
    ...account,
    skills: account.skills ?? [],
    capabilities: account.capabilities ?? [],
    stats: mergeAccountStats(account.stats),
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
  skills?: string[]
  capabilities?: string[]
  callback?: string
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
  skills?: string[]
  capabilities?: string[]
  callback?: string
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
