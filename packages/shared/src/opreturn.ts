import { LockingScript } from '@bsv/sdk'
import {
  BountyAction,
  PROTOCOL_PREFIX,
  PROTOCOL_VERSION,
  type BountyCategory,
} from './types.js'
import { bytesToHex, hexToBytes } from './hash.js'

function u64Le(n: number | bigint): Uint8Array {
  const v = BigInt(n)
  const buf = new Uint8Array(8)
  let x = v
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(x & 0xffn)
    x >>= 8n
  }
  return buf
}

function readU64Le(bytes: Uint8Array, offset: number): { value: bigint; next: number } {
  let v = 0n
  for (let i = 0; i < 8; i++) {
    v |= BigInt(bytes[offset + i]!) << BigInt(8 * i)
  }
  return { value: v, next: offset + 8 }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0)
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export interface BountyPostPayload {
  bountyId: string
  amountSats: number
  contentHash: string
  category: BountyCategory
  title: string
}

/**
 * Encode BOUNTY_POST payload bytes (after prefix/version/action).
 */
export function encodeBountyPostPayload(p: BountyPostPayload): Uint8Array {
  const id = hexToBytes(p.bountyId)
  if (id.length !== 16) throw new Error('bountyId must be 16 bytes hex')
  const hash = hexToBytes(p.contentHash)
  if (hash.length !== 32) throw new Error('contentHash must be 32 bytes hex')
  const titleBytes = new TextEncoder().encode(p.title)
  if (titleBytes.length > 255) throw new Error('title too long (max 255 bytes)')

  return concat(
    id,
    u64Le(p.amountSats),
    hash,
    new Uint8Array([p.category & 0xff]),
    new Uint8Array([titleBytes.length]),
    titleBytes,
  )
}

export function decodeBountyPostPayload(payload: Uint8Array): BountyPostPayload {
  let o = 0
  const id = payload.slice(o, o + 16)
  o += 16
  const { value: amount, next } = readU64Le(payload, o)
  o = next
  const hash = payload.slice(o, o + 32)
  o += 32
  const category = payload[o]! as BountyCategory
  o += 1
  const titleLen = payload[o]!
  o += 1
  const title = new TextDecoder().decode(payload.slice(o, o + titleLen))
  return {
    bountyId: bytesToHex(id),
    amountSats: Number(amount),
    contentHash: bytesToHex(hash),
    category,
    title,
  }
}

/**
 * Full protocol body: prefix | version | action | payload
 */
export function encodeProtocolMessage(
  action: BountyAction,
  payload: Uint8Array,
): Uint8Array {
  const prefix = new TextEncoder().encode(PROTOCOL_PREFIX)
  return concat(prefix, new Uint8Array([PROTOCOL_VERSION, action]), payload)
}

export function decodeProtocolMessage(data: Uint8Array): {
  version: number
  action: BountyAction
  payload: Uint8Array
} {
  const prefix = new TextEncoder().encode(PROTOCOL_PREFIX)
  for (let i = 0; i < prefix.length; i++) {
    if (data[i] !== prefix[i]) throw new Error('not an aibounties message')
  }
  let o = prefix.length
  const version = data[o++]!
  const action = data[o++]! as BountyAction
  const payload = data.slice(o)
  return { version, action, payload }
}

/**
 * Build OP_FALSE OP_RETURN locking script for a BOUNTY_POST.
 * Compatible with BRC-100 createAction `lockingScript` hex.
 */
export function buildBountyPostLockingScript(p: BountyPostPayload): string {
  const body = encodeProtocolMessage(
    BountyAction.POST,
    encodeBountyPostPayload(p),
  )
  // OP_FALSE OP_RETURN <push data>
  const script = LockingScript.fromASM(
    `OP_FALSE OP_RETURN ${bytesToHex(body)}`,
  )
  return script.toHex()
}

/**
 * Outputs for a Phase-1 post via BRC-100 createAction.
 * Escrow is a simple P2PKH hold to the poster; data is OP_RETURN.
 */
export function buildPostActionOutputs(opts: {
  amountSats: number
  posterLockingScriptHex: string
  post: BountyPostPayload
}): Array<{ satoshis: number; lockingScript: string; outputDescription?: string }> {
  return [
    {
      satoshis: opts.amountSats,
      lockingScript: opts.posterLockingScriptHex,
      outputDescription: 'AI Bounty escrow (Phase 1 P2PKH hold)',
    },
    {
      satoshis: 0,
      lockingScript: buildBountyPostLockingScript(opts.post),
      outputDescription: 'AI Bounty protocol data',
    },
  ]
}

export const BRC100_LABELS = {
  app: 'ai-bounties',
  post: 'bounty:post',
  claim: 'bounty:claim',
  submit: 'bounty:submit',
  settle: 'bounty:settle',
} as const
