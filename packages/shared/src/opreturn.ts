import { LockingScript } from '@bsv/sdk'
import { AccountAction } from './accounts.js'
import {
  BountyAction,
  PROTOCOL_PREFIX,
  PROTOCOL_VERSION,
  type BountyCategory,
} from './types.js'
import { bytesToHex, hexToBytes } from './hash.js'

export type ProtocolAction = BountyAction | AccountAction

function u32Le(n: number): Uint8Array {
  const buf = new Uint8Array(4)
  buf[0] = n & 0xff
  buf[1] = (n >>> 8) & 0xff
  buf[2] = (n >>> 16) & 0xff
  buf[3] = (n >>> 24) & 0xff
  return buf
}

function readU32Le(bytes: Uint8Array, offset: number): { value: number; next: number } {
  const value =
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  return { value: value >>> 0, next: offset + 4 }
}

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
  action: ProtocolAction,
  payload: Uint8Array,
): Uint8Array {
  const prefix = new TextEncoder().encode(PROTOCOL_PREFIX)
  return concat(prefix, new Uint8Array([PROTOCOL_VERSION, action]), payload)
}

export function decodeProtocolMessage(data: Uint8Array): {
  version: number
  action: ProtocolAction
  payload: Uint8Array
} {
  const prefix = new TextEncoder().encode(PROTOCOL_PREFIX)
  for (let i = 0; i < prefix.length; i++) {
    if (data[i] !== prefix[i]) throw new Error('not an aibounties message')
  }
  let o = prefix.length
  const version = data[o++]!
  const action = data[o++]! as ProtocolAction
  const payload = data.slice(o)
  return { version, action, payload }
}

// --- Phase 2 account payloads ---

export interface AccountMintPayload {
  accountNumber: number
  /** SHA-256 of controller key string (32 bytes hex). */
  controllerKeyHash: string
  kind: number // 0=human 1=agent
  nameLen: number
  displayName: string
}

export function encodeAccountMintPayload(p: AccountMintPayload): Uint8Array {
  const hash = hexToBytes(p.controllerKeyHash)
  if (hash.length !== 32) throw new Error('controllerKeyHash must be 32 bytes hex')
  const nameBytes = new TextEncoder().encode(p.displayName)
  if (nameBytes.length > 64) throw new Error('displayName too long')
  return concat(
    u32Le(p.accountNumber),
    hash,
    new Uint8Array([p.kind & 0xff, nameBytes.length]),
    nameBytes,
  )
}

export function decodeAccountMintPayload(payload: Uint8Array): AccountMintPayload {
  let o = 0
  const { value: accountNumber, next } = readU32Le(payload, o)
  o = next
  const hash = payload.slice(o, o + 32)
  o += 32
  const kind = payload[o++]!
  const nameLen = payload[o++]!
  const displayName = new TextDecoder().decode(payload.slice(o, o + nameLen))
  return {
    accountNumber,
    controllerKeyHash: bytesToHex(hash),
    kind,
    nameLen,
    displayName,
  }
}

export function buildAccountMintLockingScript(p: AccountMintPayload): string {
  const body = encodeProtocolMessage(
    AccountAction.MINT,
    encodeAccountMintPayload(p),
  )
  const script = LockingScript.fromASM(
    `OP_FALSE OP_RETURN ${bytesToHex(body)}`,
  )
  return script.toHex()
}

/**
 * Phase 2 mint outputs: 1-sat "account token" + OP_RETURN mint record.
 * Real 1Sat ordinal inscription can replace the token output later.
 */
export function buildMintAccountActionOutputs(opts: {
  ownerLockingScriptHex: string
  mint: AccountMintPayload
}): Array<{ satoshis: number; lockingScript: string; outputDescription?: string }> {
  return [
    {
      satoshis: 1,
      lockingScript: opts.ownerLockingScriptHex,
      outputDescription: `AI Bounties account #${opts.mint.accountNumber} (1sat token)`,
    },
    {
      satoshis: 0,
      lockingScript: buildAccountMintLockingScript(opts.mint),
      outputDescription: 'AI Bounties ACCOUNT_MINT data',
    },
  ]
}

export interface AccountTransferPayload {
  accountNumber: number
  toControllerKeyHash: string
  priceSats: number
}

export function encodeAccountTransferPayload(p: AccountTransferPayload): Uint8Array {
  const hash = hexToBytes(p.toControllerKeyHash)
  if (hash.length !== 32) throw new Error('toControllerKeyHash must be 32 bytes hex')
  return concat(u32Le(p.accountNumber), hash, u64Le(p.priceSats))
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
  accountMint: 'account:mint',
  accountTransfer: 'account:transfer',
  accountList: 'account:list',
} as const
