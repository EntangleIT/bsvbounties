/**
 * Two-way trust gating — read-only, no escrow writes.
 *
 * Direction A (spend -> work): BSVBounties claim verifies an agentpay
 * attestation and may waive the worker bond fully (CEO decision #2).
 * Direction B (work -> spend): agentpay pay_service reads reputation and
 * fast-paths the approval threshold x2 (CEO decision #1).
 *
 * Thresholds (CEO approved):
 *  N payments >= 10, M distinctServices >= 3, refunds == 0,
 *  reputation score >= 650, non-provisional, slashes == 0.
 * Rollout: TRUST_GATE_* = off | log | enforce, default log for 3 days (#3).
 */

export const TRUST_ATTEST_MIN_PAYMENTS = 10;
export const TRUST_ATTEST_MIN_SERVICES = 3;
export const TRUST_REPUTATION_MIN_SCORE = 650;
export const TRUST_APPROVAL_MULTIPLIER = 2;
export const TRUST_ATTEST_MAX_AGE_MS = 24 * 3_600_000;

export type TrustGateMode = 'off' | 'log' | 'enforce';

export function trustGateModeFromEnv(value: unknown): TrustGateMode {
  if (value === 'enforce') return 'enforce';
  if (value === 'off') return 'off';
  return 'log';
}

export interface AttestationMetricsLite {
  settledPayments: number;
  distinctServices: number;
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
  if ((m.refundedCents ?? 0) > 0) return { eligible: false, reason: 'has_refunds', metrics: m };
  return { eligible: true, reason: 'trusted_spender', metrics: m };
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
