/** Protocol version byte (v0.1). */
export const PROTOCOL_VERSION = 0x01

/** OP_RETURN UTF-8 prefix. */
export const PROTOCOL_PREFIX = 'aibounties'

export enum BountyAction {
  POST = 0x01,
  CLAIM = 0x02,
  SUBMIT = 0x03,
  SETTLE = 0x04,
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
  escrowTxid?: string
  settleTxid?: string
  workHash?: string
  workUri?: string
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
  /** Optional: if already broadcast, register existing tx */
  escrowTxid?: string
  network?: Network
}

export interface ClaimBountyInput {
  workerPubKey: string
  claimTxid?: string
}

export interface SubmitWorkInput {
  workHash: string
  workUri?: string
  notes?: string
  submitTxid?: string
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
