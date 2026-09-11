import type {
  AcceptanceSpec,
  ArbiterMode,
  Milestone,
  MilestoneInput,
  Verification,
} from './acceptance.js'
import type { Rfc3161Stamp, SealEnvelope } from './seal.js'

export type { Rfc3161Stamp, SealEnvelope } from './seal.js'

export type {
  AcceptanceSpec,
  Verification,
  Milestone,
  MilestoneInput,
  ArbiterMode,
} from './acceptance.js'

/** Protocol version byte (v0.1). */
export const PROTOCOL_VERSION = 0x01

/** OP_RETURN UTF-8 prefix. */
export const PROTOCOL_PREFIX = 'aibounties'

export enum BountyAction {
  POST = 0x01,
  CLAIM = 0x02,
  SUBMIT = 0x03,
  SETTLE = 0x04,
  MILESTONE = 0x05,
  DISPUTE = 0x06,
}

export enum BountyCategory {
  DEV = 0x01,
  RESEARCH = 0x02,
  CONTENT = 0x03,
  DATA = 0x04,
  DESIGN = 0x05,
  OTHER = 0xff,
}

export type BountyStatus =
  | 'open'
  | 'claimed'
  | 'submitted'
  | 'paid'
  | 'refunded'
  | 'cancelled'

export type Network = 'main' | 'test'

export interface BountyContent {
  version: 1
  title: string
  description: string
  category: keyof typeof BountyCategory | string
  requirements?: string[]
  acceptance?: AcceptanceSpec
  milestones?: MilestoneInput[]
}

/** Escrow funding mode (Phase 3). */
export type EscrowMode = 'none' | 'p2pkh' | 'scrypt'

export interface BountyEscrowMeta {
  mode: EscrowMode
  /** Numeric escrow state: 0 open, 1 claimed, 2 submitted, 3 paid, 4 refunded */
  state: number
  posterPubKey: string
  workerPubKey: string
  arbiterPubKey: string
  deadline: number
  feeBps: number
  feePkh: string
  /** Last known escrow UTXO outpoint `txid:vout` */
  outpoint?: string
  lastTxid?: string
}

/** How the poster covered the sat amount (v1 card path is off-chain USD). */
export type BountyFundingMethod = 'bsv' | 'card' | 'agentpay'

/**
 * TinyBets prediction-market metadata (P2P prop bets as bounties).
 * Maker stakes amountSats on YES; the taker matches it via worker bond on
 * NO; the oracle URL resolves it. Taker wins -> paid. Maker wins ->
 * refunded + taker bond slashed with forfeitedTo = maker (accounting;
 * on-chain bond custody is a later phase).
 */
export interface TinyBetMarket {
  kind: 'tinybets'
  /** Taker side is always NO in P0 (maker stakes YES). */
  takerSide: 'no'
  /** Resolver endpoint; GET returns JSON consumed by the http acceptance. */
  oracle: string
  /** Unix seconds: no claims/submits accepted after this (anti-sniping). */
  deadline: number
  /** Slash the taker's bond to the maker on maker win (default true). */
  forfeitBondToMaker: boolean
}

export type BountyFundingStatus = 'unfunded' | 'pending' | 'funded'

export interface BountyFunding {
  method?: BountyFundingMethod
  status: BountyFundingStatus
  /** Stripe Checkout Session id (`cs_…`) when method is card. */
  stripeCheckoutSessionId?: string
  /** USD cents charged at Checkout (includes documented USD fee). */
  amountUsdCents?: number
  /** Sat amount this charge is covering. */
  amountSats?: number
  /** USD per BSV used when quoting the card charge. */
  bsvUsd?: number
  /** USD fee in basis points applied on the card charge (not the sat payout fee). */
  usdFeeBps?: number
  /** Stripe `integration_identifier` used for this Checkout Session. */
  integrationIdentifier?: string
  fundedAt?: string
}

export function isBountyFunded(
  bounty: Pick<Bounty, 'funding' | 'escrowTxid'>,
): boolean {
  if (bounty.funding?.status === 'funded') return true
  return Boolean(bounty.escrowTxid)
}

export interface Bounty {
  id: string
  title: string
  description: string
  category: string
  requirements: string[]
  amountSats: number
  contentHash: string
  status: BountyStatus
  posterPubKey?: string
  workerPubKey?: string
  /** Phase 2: numbered account of poster / worker. */
  posterAccount?: number
  workerAccount?: number
  escrowTxid?: string
  settleTxid?: string
  workHash?: string
  workUri?: string
  /** Trust B: sealed-submission envelope (custody proof + timestamps). */
  seal?: SealEnvelope
  /** Card (Stripe Checkout) or on-chain BSV deposit. */
  funding?: BountyFunding
  /** Phase 3 escrow covenant metadata */
  escrow?: BountyEscrowMeta
  /** Machine-checkable acceptance (default manual). */
  acceptance?: AcceptanceSpec
  /**
   * TinyBets prediction market metadata. When present, the bounty is a
   * maker-vs-taker prop bet: maker stakes amountSats on YES, the taker
   * matches it via worker bond on NO, and the oracle settles it.
   */
  market?: TinyBetMarket
  arbiterMode?: ArbiterMode
  milestones?: Milestone[]
  currentMilestone?: number
  releasedSats?: number
  lastVerification?: Verification
  claimedAt?: string
  createdAt: string
  updatedAt: string
  network: Network
}

export interface CreateBountyInput {
  title: string
  description: string
  category?: string
  requirements?: string[]
  amountSats: number
  posterPubKey?: string
  posterAccount?: number
  /** Optional: if already broadcast, register existing tx */
  escrowTxid?: string
  network?: Network
  acceptance?: AcceptanceSpec
  arbiter?: 'llm' | string
  milestones?: MilestoneInput[]
}

export interface ClaimBountyInput {
  workerPubKey: string
  workerAccount?: number
  claimTxid?: string
}

export interface SubmitWorkInput {
  workHash?: string
  workUri?: string
  notes?: string
  submitTxid?: string
  milestoneIndex?: number
  /** Trust B: sealed-submission envelope from createSubmitSeal(). */
  seal?: SealEnvelope
}

export interface SettleBountyInput {
  outcome: 'paid' | 'refunded'
  settleTxid?: string
  workerAddress?: string
}

export interface ListBountiesQuery {
  status?: BountyStatus
  category?: string
  limit?: number
  offset?: number
}

export const CATEGORY_LABELS: Record<number, string> = {
  [BountyCategory.DEV]: 'dev',
  [BountyCategory.RESEARCH]: 'research',
  [BountyCategory.CONTENT]: 'content',
  [BountyCategory.DATA]: 'data',
  [BountyCategory.DESIGN]: 'design',
  [BountyCategory.OTHER]: 'other',
}

export function categoryFromLabel(label: string): BountyCategory {
  const n = label.toLowerCase()
  const entry = Object.entries(CATEGORY_LABELS).find(([, v]) => v === n)
  if (entry) return Number(entry[0]) as BountyCategory
  return BountyCategory.OTHER
}

export function categoryToLabel(code: number): string {
  return CATEGORY_LABELS[code] ?? 'other'
}
