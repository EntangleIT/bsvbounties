/**
 * Spend -> work trust: verify agentpay attestations offline and decide
 * bond waive. Read-only, fail closed. No escrow writes.
 */
import { trustGateForClaim, trustGateModeFromEnv, type AttestationLite } from '@ai-bounties/shared'

export type TrustClaimMode = 'off' | 'log' | 'enforce'

export function trustClaimMode(): TrustClaimMode {
  return trustGateModeFromEnv(process.env.TRUST_GATE_CLAIM)
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function fromBase64Url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  const bin = atob(b64 + pad)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

let keyCache: { at: number; jwk: JsonWebKey; keyId: string } | null = null
const KEY_TTL_MS = 60 * 60_000

async function agentpayPublicKey(): Promise<{ jwk: JsonWebKey; keyId: string } | null> {
  if (keyCache && Date.now() - keyCache.at < KEY_TTL_MS) return keyCache
  const base =
    process.env.AGENTPAY_PUBLIC_URL || 'https://entangleit.com/api/agentpay'
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/attestations/key`)
    if (!res.ok) return keyCache
    const body = (await res.json()) as { publicJwk?: JsonWebKey; keyId?: string }
    if (!body.publicJwk || typeof body.keyId !== 'string') return keyCache
    keyCache = { at: Date.now(), jwk: body.publicJwk, keyId: body.keyId }
    return keyCache
  } catch {
    return keyCache
  }
}

export async function verifyAgentpayAttestation(
  attestation: AttestationLite,
  signature: string,
  keyId?: string,
): Promise<{ valid: boolean; keyIdMatches: boolean | null }> {
  try {
    const key = await agentpayPublicKey()
    if (!key) return { valid: false, keyIdMatches: null }
    const pub = await crypto.subtle.importKey(
      'jwk',
      key.jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    const sig = fromBase64Url(signature)
    const data = new TextEncoder().encode(stableStringify(attestation))
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pub,
      sig.buffer as ArrayBuffer,
      data.buffer as ArrayBuffer,
    )
    return {
      valid,
      keyIdMatches: typeof keyId === 'string' ? keyId === key.keyId : null,
    }
  } catch {
    return { valid: false, keyIdMatches: null }
  }
}

export interface ClaimTrustInput {
  attestation?: unknown
  signature?: unknown
  keyId?: unknown
  /** Claimant identity the attestation must be bound to (workerPubKey). */
  expectedSub?: string
}

export async function evaluateClaimTrust(input: ClaimTrustInput): Promise<{
  eligible: boolean
  reason: string
  verified: boolean
  subMatch: boolean
  mode: TrustClaimMode
}> {
  const mode = trustClaimMode()
  if (mode === 'off') return { eligible: false, reason: 'disabled', verified: false, subMatch: false, mode }
  const { attestation, signature, keyId, expectedSub } = input
  if (!attestation || typeof signature !== 'string') {
    return { eligible: false, reason: 'no_attestation', verified: false, subMatch: false, mode }
  }
  const { valid } = await verifyAgentpayAttestation(
    attestation as AttestationLite,
    signature,
    typeof keyId === 'string' ? keyId : undefined,
  )
  if (!valid) return { eligible: false, reason: 'bad_signature', verified: false, subMatch: false, mode }
  // Binding: attestation.sub must equal the claimant. Unbound legacy
  // attestations (no sub) fail closed when a claimant is known.
  const sub = (attestation as AttestationLite).sub
  if (typeof expectedSub === 'string' && expectedSub.length > 0) {
    if (typeof sub !== 'string' || sub !== expectedSub) {
      return { eligible: false, reason: 'sub_mismatch', verified: true, subMatch: false, mode }
    }
  }
  const gate = trustGateForClaim(attestation as AttestationLite)
  return { eligible: gate.eligible, reason: gate.reason, verified: true, subMatch: true, mode }
}
