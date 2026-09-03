import type { Network } from './types.js'
import { median } from './acceptance.js'
import type { TwetchIdentity } from './twetch.js'

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
  /**
   * Linked Twetch OIDC identity ("Sign in with Twetch"). One Twetch `sub`
   * verifies at most one account. Cleared on transfer — the buyer links
   * their own identity. Reputation stats stay with the number.
   */
  twetch?: TwetchIdentity
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
  /** Deterministic 0–1000 score (Trust C). See reputationScore(). */
  score: number
  tier: ReputationTier
  /** True until the account has judged work or a completion. */
  provisional: boolean
  /** Twetch-verified (Trust A) at scoring time. */
  verified: boolean
  contributions: ReputationContributions
}

export type ReputationTier = 'S' | 'A' | 'B' | 'C' | 'D'

export interface ReputationContributions {
  completion: number
  quality: number
  slashes: number
  latency: number
  verified: number
}

/**
 * Score weights (Trust C v1). Tunable — bump by editing here, no migration:
 * the score is always computed at read time from stats.
 */
export const REPUTATION_WEIGHTS = {
  /** Base for accounts with no history (provisional, mid-table). */
  base: 500,
  /** Per completed bounty, capped. */
  completionEach: 8,
  completionCap: 120,
  /** ± swing for pass-rate, scaled by confidence min(judged,20)/20. */
  qualitySwing: 400,
  qualityConfidenceAt: 20,
  /** Per slash. */
  slashEach: -150,
  /** Median submit latency bonuses/penalties (ms thresholds). */
  latencyFastMs: 3_600_000,
  latencyFastBonus: 30,
  latencyOkMs: 86_400_000,
  latencyOkBonus: 10,
  latencySlowMs: 7 * 86_400_000,
  latencySlowPenalty: -30,
  /** Trust A bonus for Twetch-verified accounts. */
  verifiedBonus: 25,
  min: 0,
  max: 1000,
} as const

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

export function reputationScore(
  stats: Partial<AccountStats> | undefined,
  opts: { verified?: boolean } = {},
): {
  score: number
  tier: ReputationTier
  provisional: boolean
  contributions: ReputationContributions
} {
  const s = mergeAccountStats(stats)
  const w = REPUTATION_WEIGHTS
  const judged = s.verifiesPassed + s.verifiesFailed

  const completion = Math.min(s.bountiesCompleted * w.completionEach, w.completionCap)
  let quality = 0
  if (judged > 0) {
    const passRate = s.verifiesPassed / judged
    const confidence = Math.min(judged, w.qualityConfidenceAt) / w.qualityConfidenceAt
    quality = Math.round((passRate - 0.5) * w.qualitySwing * confidence)
  }
  const slashes = s.slashes * w.slashEach
  let latency = 0
  const med = median(s.submitDurationsMs)
  if (med != null) {
    if (med <= w.latencyFastMs) latency = w.latencyFastBonus
    else if (med <= w.latencyOkMs) latency = w.latencyOkBonus
    else if (med >= w.latencySlowMs) latency = w.latencySlowPenalty
  }
  const verified = opts.verified ? w.verifiedBonus : 0

  const score = Math.min(
    w.max,
    Math.max(w.min, Math.round(w.base + completion + quality + slashes + latency + verified)),
  )
  const tier: ReputationTier =
    score >= 800 ? 'S' : score >= 650 ? 'A' : score >= 500 ? 'B' : score >= 350 ? 'C' : 'D'
  return {
    score,
    tier,
    provisional: judged === 0 && s.bountiesCompleted === 0,
    contributions: { completion, quality, slashes, latency, verified },
  }
}

export function reputationOf(account: Account): AccountReputation {
  const s = mergeAccountStats(account.stats)
  const judged = s.verifiesPassed + s.verifiesFailed
  const verified =
    typeof account.twetch?.sub === 'string' && account.twetch.sub.length > 0
  const scored = reputationScore(s, { verified })
  return {
    verifyPassRate: judged === 0 ? null : s.verifiesPassed / judged,
    medianTimeToSubmitMs: median(s.submitDurationsMs),
    slashes: s.slashes,
    score: scored.score,
    tier: scored.tier,
    provisional: scored.provisional,
    verified,
    contributions: scored.contributions,
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
