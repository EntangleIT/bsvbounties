/**
 * Sealed work submissions (Trust B).
 *
 * A `SealEnvelope` binds a deliverable hash to a submitter and a moment in
 * time, witnesscam-style:
 *
 *   1. Hash-chained custody events (tamper-evident, offline-verifiable).
 *   2. Optional RFC 3161 trusted timestamp (independent TSA attests the
 *      hash existed at genTime — only the digest leaves the machine).
 *   3. Optional on-chain anchor txid (BSV OP_RETURN commitment).
 *
 * Unlike `hash`/`http` acceptance, `sealed` never fetches the artifact:
 * the proof is existence + custody, so private/encrypted/offline work can
 * still be proven. Pair with `hash`/`llm-judge` milestones for content
 * inspection.
 */

import { sha256Hex } from './hash.js'
import {
  verifyRfc3161Binding,
  type Rfc3161Stamp,
} from './rfc3161.js'

export type { Rfc3161Stamp } from './rfc3161.js'

export const SEAL_VERSION = 1 as const

export const GENESIS_PREV_HASH =
  '0000000000000000000000000000000000000000000000000000000000000000'

export type SealEventType =
  | 'SUBMITTED'
  | 'STAMPED'
  | 'ANCHORED'
  | 'DISPUTED'
  | 'RESOLVED'

export interface SealEvent {
  prevHash: string
  type: SealEventType
  at: string
  actorId: string
  actorName: string
  contentHash: string
  meta: Record<string, string>
  eventHash: string
}

export interface SealSubmitter {
  controllerKey?: string
  accountNumber?: number
  displayName?: string
}

export interface SealEnvelope {
  version: number
  workHash: string
  submitter: SealSubmitter
  events: SealEvent[]
  rfc3161?: Rfc3161Stamp
  anchorTxid?: string
}

function isHex64(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s)
}

export function serializeSealEvent(
  event: Omit<SealEvent, 'eventHash'>,
): string {
  const metaKeys = Object.keys(event.meta).sort()
  const meta = metaKeys.map((k) => `${k}=${event.meta[k]}`).join('&')
  return [
    event.prevHash,
    event.type,
    event.at,
    event.actorId,
    event.actorName,
    event.contentHash,
    meta,
  ].join('|')
}

export function hashSealEvent(event: Omit<SealEvent, 'eventHash'>): string {
  return sha256Hex(serializeSealEvent(event))
}

export function appendSealEvent(params: {
  prevHash: string
  type: SealEventType
  at?: string
  actorId: string
  actorName: string
  contentHash: string
  meta?: Record<string, string>
}): SealEvent {
  const body: Omit<SealEvent, 'eventHash'> = {
    prevHash: params.prevHash,
    type: params.type,
    at: params.at ?? new Date().toISOString(),
    actorId: params.actorId,
    actorName: params.actorName,
    contentHash: params.contentHash,
    meta: params.meta ?? {},
  }
  return { ...body, eventHash: hashSealEvent(body) }
}

/** Create a fresh envelope for a submission (genesis SUBMITTED event). */
export function createSubmitSeal(opts: {
  workHash: string
  submitter: SealSubmitter
  at?: string
}): SealEnvelope {
  const workHash = opts.workHash.toLowerCase()
  if (!isHex64(workHash)) throw new Error('seal_bad_work_hash')
  const actorId =
    opts.submitter.controllerKey ??
    (opts.submitter.accountNumber != null
      ? `account:${opts.submitter.accountNumber}`
      : 'anonymous')
  const first = appendSealEvent({
    prevHash: GENESIS_PREV_HASH,
    type: 'SUBMITTED',
    at: opts.at,
    actorId,
    actorName: opts.submitter.displayName ?? actorId,
    contentHash: workHash,
  })
  return {
    version: SEAL_VERSION,
    workHash,
    submitter: opts.submitter,
    events: [first],
  }
}

export interface SealChainCheck {
  ok: boolean
  index?: number
  reason?: string
  tip?: string
}

/** Offline custody-chain verification: linkage + recomputed hashes. */
export function verifySealChain(events: SealEvent[]): SealChainCheck {
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, reason: 'seal_empty_chain' }
  }
  let prev = GENESIS_PREV_HASH
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!
    if (e.prevHash !== prev) {
      return { ok: false, index: i, reason: 'seal_broken_link' }
    }
    const expected = hashSealEvent({
      prevHash: e.prevHash,
      type: e.type,
      at: e.at,
      actorId: e.actorId,
      actorName: e.actorName,
      contentHash: e.contentHash,
      meta: e.meta ?? {},
    })
    if (expected !== e.eventHash) {
      return { ok: false, index: i, reason: 'seal_event_hash_mismatch' }
    }
    prev = e.eventHash
  }
  return { ok: true, tip: prev }
}

export interface SealVerifyOpts {
  /** Submitted workHash the envelope must bind (lowercase compare). */
  expectedWorkHash?: string
  /** When the caller authenticated the submitter, bind the envelope to them. */
  expectedSubmitter?: SealSubmitter
  nowMs?: number
}

export interface SealVerifyResult {
  ok: boolean
  reason: string
  tip?: string
  genTime?: string
}

/**
 * Full offline envelope verification: shape, chain, hash binding,
 * optional submitter binding, optional timestamp binding.
 */
export function verifySealEnvelope(
  envelope: SealEnvelope,
  opts: SealVerifyOpts = {},
): SealVerifyResult {
  if (!envelope || typeof envelope !== 'object') {
    return { ok: false, reason: 'seal_missing' }
  }
  if (envelope.version !== SEAL_VERSION) {
    return { ok: false, reason: 'seal_bad_version' }
  }
  if (!isHex64(envelope.workHash)) {
    return { ok: false, reason: 'seal_bad_work_hash' }
  }
  const workHash = envelope.workHash.toLowerCase()
  if (opts.expectedWorkHash && opts.expectedWorkHash.toLowerCase() !== workHash) {
    return { ok: false, reason: 'seal_hash_mismatch' }
  }
  const chain = verifySealChain(envelope.events)
  if (!chain.ok) return { ok: false, reason: chain.reason ?? 'seal_invalid' }
  for (const e of envelope.events) {
    if (e.contentHash.toLowerCase() !== workHash) {
      return { ok: false, reason: 'seal_event_hash_mismatch' }
    }
  }
  const first = envelope.events[0]!
  if (first.type !== 'SUBMITTED') {
    return { ok: false, reason: 'seal_bad_genesis' }
  }
  if (opts.expectedSubmitter?.controllerKey) {
    const got = envelope.submitter.controllerKey
    if (got && got !== opts.expectedSubmitter.controllerKey) {
      return { ok: false, reason: 'seal_actor_mismatch' }
    }
  }
  if (envelope.rfc3161) {
    try {
      const { genTime } = verifyRfc3161Binding(
        envelope.rfc3161.tokenB64,
        workHash,
        opts.nowMs,
      )
      if (
        envelope.rfc3161.hashedMessage.toLowerCase() !== workHash
      ) {
        return { ok: false, reason: 'seal_stamp_hash_mismatch' }
      }
      return { ok: true, reason: 'sealed_timestamp_verified', tip: chain.tip, genTime }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Namespaced seal_* reasons pass through; raw DER/codec errors collapse.
      return { ok: false, reason: msg.startsWith('seal_') ? msg : 'seal_bad_token' }
    }
  }
  return { ok: true, reason: 'sealed_chain_valid', tip: chain.tip }
}
