/**
 * Pure TypeScript escrow state machine (Phase 3).
 * Mirrors the sCrypt BountyEscrow contract rules so the API and UI
 * can validate transitions without compiling Script.
 */

export enum EscrowState {
  OPEN = 0,
  CLAIMED = 1,
  SUBMITTED = 2,
  /** Terminal — not represented as a live UTXO */
  PAID = 3,
  REFUNDED = 4,
}

export type EscrowMethod =
  | 'claim'
  | 'submit'
  | 'approve'
  | 'refund'
  | 'cancel'
  | 'resolve'

export interface EscrowSnapshot {
  state: EscrowState
  amountSats: number
  bountyId: string
  contentHash: string
  /** Compressed or uncompressed pubkey hex (poster). */
  posterPubKey: string
  /** Empty string until claimed. */
  workerPubKey: string
  /** Optional arbiter; empty = no dispute path. */
  arbiterPubKey: string
  /** Unix time or block height; 0 = no deadline. */
  deadline: number
  /** Work commitment; empty until submit. */
  workHash: string
  /** Platform fee in basis points (0–10000), applied on approve. */
  feeBps: number
  /** Platform P2PKH hash160 hex (20 bytes) for fee output; empty = no fee split. */
  feePkh: string
}

export interface TransitionInput {
  method: EscrowMethod
  /** Caller role pubkey hex. */
  signerPubKey: string
  workerPubKey?: string
  workHash?: string
  /** For resolve: true → pay worker, false → refund poster. */
  payWorker?: boolean
  /** Current chain time/height for deadline checks. */
  now?: number
}

export interface TransitionResult {
  ok: true
  next: EscrowSnapshot
  /** Terminal payout description for API/wallet templates. */
  payout?: {
    type: 'worker' | 'poster' | 'split'
    workerSats?: number
    posterSats?: number
    feeSats?: number
  }
}

export interface TransitionError {
  ok: false
  error: string
}

export function stateName(s: EscrowState): string {
  return EscrowState[s] ?? String(s)
}

export function isTerminal(s: EscrowState): boolean {
  return s === EscrowState.PAID || s === EscrowState.REFUNDED
}

export function applyTransition(
  current: EscrowSnapshot,
  input: TransitionInput,
): TransitionResult | TransitionError {
  if (isTerminal(current.state)) {
    return { ok: false, error: 'escrow_terminal' }
  }

  switch (input.method) {
    case 'claim':
      return claim(current, input)
    case 'submit':
      return submit(current, input)
    case 'approve':
      return approve(current, input)
    case 'cancel':
      return cancel(current, input)
    case 'refund':
      return refund(current, input)
    case 'resolve':
      return resolve(current, input)
    default:
      return { ok: false, error: 'unknown_method' }
  }
}

function claim(
  c: EscrowSnapshot,
  input: TransitionInput,
): TransitionResult | TransitionError {
  if (c.state !== EscrowState.OPEN) {
    return { ok: false, error: 'must_be_open' }
  }
  const worker = input.workerPubKey ?? input.signerPubKey
  if (!worker || worker.length < 8) {
    return { ok: false, error: 'worker_pubkey_required' }
  }
  if (worker === c.posterPubKey) {
    return { ok: false, error: 'poster_cannot_claim' }
  }
  return {
    ok: true,
    next: {
      ...c,
      state: EscrowState.CLAIMED,
      workerPubKey: worker,
    },
  }
}

function submit(
  c: EscrowSnapshot,
  input: TransitionInput,
): TransitionResult | TransitionError {
  if (c.state !== EscrowState.CLAIMED && c.state !== EscrowState.SUBMITTED) {
    return { ok: false, error: 'must_be_claimed' }
  }
  if (input.signerPubKey !== c.workerPubKey) {
    return { ok: false, error: 'worker_only' }
  }
  const workHash = input.workHash
  if (!workHash || workHash.length < 16) {
    return { ok: false, error: 'work_hash_required' }
  }
  return {
    ok: true,
    next: {
      ...c,
      state: EscrowState.SUBMITTED,
      workHash,
    },
  }
}

function approve(
  c: EscrowSnapshot,
  input: TransitionInput,
): TransitionResult | TransitionError {
  if (c.state !== EscrowState.CLAIMED && c.state !== EscrowState.SUBMITTED) {
    return { ok: false, error: 'must_be_claimed_or_submitted' }
  }
  if (input.signerPubKey !== c.posterPubKey) {
    return { ok: false, error: 'poster_only' }
  }
  if (!c.workerPubKey) {
    return { ok: false, error: 'no_worker' }
  }
  const feeSats = feeAmount(c.amountSats, c.feeBps)
  const workerSats = c.amountSats - feeSats
  return {
    ok: true,
    next: { ...c, state: EscrowState.PAID },
    payout: {
      type: feeSats > 0 ? 'split' : 'worker',
      workerSats,
      feeSats: feeSats > 0 ? feeSats : undefined,
    },
  }
}

function cancel(
  c: EscrowSnapshot,
  input: TransitionInput,
): TransitionResult | TransitionError {
  // Poster cancels unclaimed bounty
  if (c.state !== EscrowState.OPEN) {
    return { ok: false, error: 'must_be_open' }
  }
  if (input.signerPubKey !== c.posterPubKey) {
    return { ok: false, error: 'poster_only' }
  }
  return {
    ok: true,
    next: { ...c, state: EscrowState.REFUNDED },
    payout: { type: 'poster', posterSats: c.amountSats },
  }
}

function refund(
  c: EscrowSnapshot,
  input: TransitionInput,
): TransitionResult | TransitionError {
  // Poster refund after deadline while claimed/submitted (worker abandoned)
  if (c.state !== EscrowState.CLAIMED && c.state !== EscrowState.SUBMITTED) {
    return { ok: false, error: 'must_be_claimed_or_submitted' }
  }
  if (input.signerPubKey !== c.posterPubKey) {
    return { ok: false, error: 'poster_only' }
  }
  if (c.deadline > 0) {
    const now = input.now ?? Math.floor(Date.now() / 1000)
    if (now < c.deadline) {
      return { ok: false, error: 'deadline_not_reached' }
    }
  } else {
    return { ok: false, error: 'no_deadline_use_resolve_or_approve' }
  }
  return {
    ok: true,
    next: { ...c, state: EscrowState.REFUNDED },
    payout: { type: 'poster', posterSats: c.amountSats },
  }
}

function resolve(
  c: EscrowSnapshot,
  input: TransitionInput,
): TransitionResult | TransitionError {
  if (c.state !== EscrowState.CLAIMED && c.state !== EscrowState.SUBMITTED) {
    return { ok: false, error: 'must_be_claimed_or_submitted' }
  }
  if (!c.arbiterPubKey) {
    return { ok: false, error: 'no_arbiter' }
  }
  if (input.signerPubKey !== c.arbiterPubKey) {
    return { ok: false, error: 'arbiter_only' }
  }
  if (input.payWorker) {
    const feeSats = feeAmount(c.amountSats, c.feeBps)
    return {
      ok: true,
      next: { ...c, state: EscrowState.PAID },
      payout: {
        type: feeSats > 0 ? 'split' : 'worker',
        workerSats: c.amountSats - feeSats,
        feeSats: feeSats > 0 ? feeSats : undefined,
      },
    }
  }
  return {
    ok: true,
    next: { ...c, state: EscrowState.REFUNDED },
    payout: { type: 'poster', posterSats: c.amountSats },
  }
}

export function feeAmount(amountSats: number, feeBps: number): number {
  if (feeBps <= 0) return 0
  return Math.floor((amountSats * feeBps) / 10_000)
}

/** Map app BountyStatus ↔ escrow state for open escrows. */
export function bountyStatusFromEscrow(s: EscrowState): string {
  switch (s) {
    case EscrowState.OPEN:
      return 'open'
    case EscrowState.CLAIMED:
      return 'claimed'
    case EscrowState.SUBMITTED:
      return 'submitted'
    case EscrowState.PAID:
      return 'paid'
    case EscrowState.REFUNDED:
      return 'refunded'
    default:
      return 'open'
  }
}

export function escrowStateFromBountyStatus(status: string): EscrowState {
  switch (status) {
    case 'open':
      return EscrowState.OPEN
    case 'claimed':
      return EscrowState.CLAIMED
    case 'submitted':
      return EscrowState.SUBMITTED
    case 'paid':
      return EscrowState.PAID
    case 'refunded':
    case 'cancelled':
      return EscrowState.REFUNDED
    default:
      return EscrowState.OPEN
  }
}
