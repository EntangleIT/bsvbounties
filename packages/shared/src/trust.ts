/**
 * Two-way trust gating — read-only, no escrow writes.
 *
 * Direction A (spend -> work): BSVBounties claim verifies an agentpay
 * attestation and discounts the worker bond 50% until wallet↔account
 * binding lands (CEO: breaking changes fine, 50% until bound).
 * Direction B (work -> spend): agentpay pay_service reads reputation and
 * fast-paths the approval threshold x2.
 *
 * Thresholds: N payments >= 10, M distinctServices >= 3 (and distinctPayTo
 * >= 3 when present), spentCents >= 50, wallet age >= 7d, refunds == 0;
 * reputation score >= 650, non-provisional, slashes == 0.
 * Rollout: TRUST_GATE_* = off | log | enforce, default log.
 */

export const TRUST_ATTEST_MIN_PAYMENTS = 10;
export const TRUST_ATTEST_MIN_SERVICES = 3;
export const TRUST_ATTEST_MIN_SPENT_CENTS = 50;
export const TRUST_ATTEST_MIN_WALLET_AGE_MS = 7 * 86_400_000;
export const TRUST_REPUTATION_MIN_SCORE = 650;
export const TRUST_APPROVAL_MULTIPLIER = 2;
export const TRUST_ATTEST_MAX_AGE_MS = 24 * 3_600_000;
/** 50% bond discount until wallet↔account binding ships, then 10000. */
export const TRUST_BOND_DISCOUNT_BPS_UNBOUND = 5000;
export const TRUST_BOND_DISCOUNT_BPS_BOUND = 10000;

export type TrustGateMode = 'off' | 'log' | 'enforce';

export function trustGateModeFromEnv(value: unknown): TrustGateMode {
  if (value === 'enforce') return 'enforce';
  if (value === 'off') return 'off';
  return 'log';
}

export interface AttestationMetricsLite {
  settledPayments: number;
  distinctServices: number;
  /** Distinct on-chain payees when the issuer tracks it (anti-wash). */
  distinctPayTo?: number;
  spentCents: number;
  refundedCents: number;
  bountyPayouts?: number;
  earnedCents?: number;
  firstPaymentAt?: string | null;
  lastPaymentAt?: string | null;
}

export interface AttestationLite {
  v: number;
  iss: string;
  wallet?: string;
  /** Optional claimant binding (workerPubKey/account) — verified in A2. */
  sub?: string;
  windowDays?: number;
  issuedAt: string;
  expiresAt: string;
  metrics: AttestationMetricsLite;
}

export interface ClaimTrustDecision {
  eligible: boolean;
  reason: string;
  metrics?: AttestationMetricsLite;
}

/** Pure gate: spend history -> bond waive eligibility. Fail closed on bad input. */
export function trustGateForClaim(
  attestation: AttestationLite | null | undefined,
  nowMs: number = Date.now(),
): ClaimTrustDecision {
  if (!attestation || typeof attestation !== 'object') {
    return { eligible: false, reason: 'no_attestation' };
  }
  const m = attestation.metrics;
  if (!m || typeof m.settledPayments !== 'number' || typeof m.distinctServices !== 'number') {
    return { eligible: false, reason: 'bad_metrics' };
  }
  if (typeof attestation.expiresAt === 'string') {
    const exp = Date.parse(attestation.expiresAt);
    if (Number.isFinite(exp) && exp <= nowMs) return { eligible: false, reason: 'expired' };
  }
  if (typeof attestation.issuedAt === 'string') {
    const issued = Date.parse(attestation.issuedAt);
    if (Number.isFinite(issued) && nowMs - issued > TRUST_ATTEST_MAX_AGE_MS) {
      return { eligible: false, reason: 'stale' };
    }
  }
  if (m.settledPayments < TRUST_ATTEST_MIN_PAYMENTS) return { eligible: false, reason: 'too_few_payments', metrics: m };
  if (m.distinctServices < TRUST_ATTEST_MIN_SERVICES) return { eligible: false, reason: 'too_few_services', metrics: m };
  if (typeof m.distinctPayTo === 'number' && m.distinctPayTo < TRUST_ATTEST_MIN_SERVICES) {
    return { eligible: false, reason: 'too_few_payees', metrics: m };
  }
  if ((m.spentCents ?? 0) < TRUST_ATTEST_MIN_SPENT_CENTS) return { eligible: false, reason: 'spend_too_low', metrics: m };
  if (typeof m.firstPaymentAt === 'string' && m.firstPaymentAt) {
    const first = Date.parse(m.firstPaymentAt);
    if (Number.isFinite(first) && nowMs - first < TRUST_ATTEST_MIN_WALLET_AGE_MS) {
      return { eligible: false, reason: 'wallet_too_new', metrics: m };
    }
  }
  if ((m.refundedCents ?? 0) > 0) return { eligible: false, reason: 'has_refunds', metrics: m };
  return { eligible: true, reason: 'trusted_spender', metrics: m };
}

/** Bond discount in bps: 50% until wallet↔account binding ships, then full. */
export function trustBondDiscountBps(eligible: boolean, bound: boolean): number {
  if (!eligible) return 0;
  return bound ? TRUST_BOND_DISCOUNT_BPS_BOUND : TRUST_BOND_DISCOUNT_BPS_UNBOUND;
}

export interface ReputationLite {
  score: number;
  provisional: boolean;
  slashes: number;
  tier?: string;
  verified?: boolean;
}

export interface PayTrustDecision {
  fastPath: boolean;
  reason: string;
  effectiveMultiplier: number;
}

/** Pure gate: work reputation -> approval fast-path. Never raises limits. */
export function trustGateForPay(rep: ReputationLite | null | undefined): PayTrustDecision {
  if (!rep || typeof rep.score !== 'number') return { fastPath: false, reason: 'no_reputation', effectiveMultiplier: 1 };
  if (rep.provisional) return { fastPath: false, reason: 'provisional', effectiveMultiplier: 1 };
  if ((rep.slashes ?? 0) > 0) return { fastPath: false, reason: 'has_slashes', effectiveMultiplier: 1 };
  if (rep.score < TRUST_REPUTATION_MIN_SCORE) return { fastPath: false, reason: 'score_too_low', effectiveMultiplier: 1 };
  return { fastPath: true, reason: 'trusted_worker', effectiveMultiplier: TRUST_APPROVAL_MULTIPLIER };
}

/** Effective approval threshold after trust. Only increases (loosens), never decreases limits. */
export function effectiveApprovalThreshold(
  base: number | null,
  decision: PayTrustDecision,
): number | null {
  if (base === null || !decision.fastPath) return base;
  return base * decision.effectiveMultiplier;
}
