import { Hash, LockingScript, PublicKey } from '@bsv/sdk'
import {
  BRC100_LABELS,
  buildBountyPostLockingScript,
  categoryFromLabel,
  type BountyCategory,
} from '@ai-bounties/shared'
import {
  EscrowState,
  type EscrowSnapshot,
  type TransitionResult,
  feeAmount,
  stateName,
} from './escrowState.js'

/**
 * Phase 3 escrow parameter OP_RETURN.
 * Production covenants use compiled sCrypt locking scripts; until then
 * value is held in poster P2PKH and state is enforced by the app + this record.
 */
export function buildEscrowParamScript(snapshot: EscrowSnapshot): string {
  const prefix = new TextEncoder().encode('aibounties-escrow')
  const parts: Uint8Array[] = [
    prefix,
    new Uint8Array([1]),
    new Uint8Array([snapshot.state & 0xff]),
    u64(snapshot.amountSats),
    hexToFixed(snapshot.bountyId, 16),
    hexToFixed(snapshot.contentHash, 32),
    lenPrefixedHex(snapshot.posterPubKey),
    lenPrefixedHex(snapshot.workerPubKey || ''),
    lenPrefixedHex(snapshot.arbiterPubKey || ''),
    u64(snapshot.deadline),
    lenPrefixedHex(snapshot.workHash || ''),
    new Uint8Array([(snapshot.feeBps >> 8) & 0xff, snapshot.feeBps & 0xff]),
    lenPrefixedHex(snapshot.feePkh || ''),
  ]
  const body = concat(parts)
  const script = LockingScript.fromASM(
    `OP_FALSE OP_RETURN ${bytesToHex(body)}`,
  )
  return script.toHex()
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0)
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function u64(n: number): Uint8Array {
  const b = new Uint8Array(8)
  let x = BigInt(n)
  for (let i = 0; i < 8; i++) {
    b[i] = Number(x & 0xffn)
    x >>= 8n
  }
  return b
}

function hexToFixed(hex: string, byteLen: number): Uint8Array {
  const clean = (hex.startsWith('0x') ? hex.slice(2) : hex)
    .padEnd(byteLen * 2, '0')
    .slice(0, byteLen * 2)
  return hexToBytes(clean)
}

function lenPrefixedHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const data = clean.length ? hexToBytes(clean) : new Uint8Array(0)
  if (data.length > 255) throw new Error('field too long')
  const out = new Uint8Array(1 + data.length)
  out[0] = data.length
  out.set(data, 1)
  return out
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Build standard P2PKH locking script from 20-byte hash160 hex. */
export function p2pkhFromHash160(hash160Hex: string): string {
  const h = hash160Hex.startsWith('0x') ? hash160Hex.slice(2) : hash160Hex
  if (h.length !== 40) throw new Error('hash160 must be 20 bytes hex')
  return LockingScript.fromASM(
    `OP_DUP OP_HASH160 ${h} OP_EQUALVERIFY OP_CHECKSIG`,
  ).toHex()
}

/** P2PKH lock from 20-byte pkh hex or full pubkey hex (or demo string key). */
export function p2pkhFromPubKeyHex(pubKeyHex: string): string {
  const clean = pubKeyHex.startsWith('0x') ? pubKeyHex.slice(2) : pubKeyHex
  if (clean.length === 40 && /^[0-9a-fA-F]+$/.test(clean)) {
    return p2pkhFromHash160(clean)
  }
  try {
    const pk = PublicKey.fromString(clean)
    const hash = pk.toHash()
    const hex =
      typeof hash === 'string'
        ? hash
        : bytesToHex(hash instanceof Uint8Array ? hash : new Uint8Array(hash))
    return p2pkhFromHash160(hex.length === 40 ? hex : hex.slice(0, 40))
  } catch {
    // Demo / non-EC keys: RIPEMD160(SHA256(utf8)) style 20-byte stand-in
    const enc = new TextEncoder().encode(clean)
    const sha = Hash.sha256(Array.from(enc))
    const h160 = Hash.hash160(sha)
    const hex = bytesToHex(
      h160 instanceof Uint8Array ? h160 : new Uint8Array(h160 as number[]),
    )
    return p2pkhFromHash160(hex.slice(0, 40))
  }
}

export interface CreateActionTemplate {
  description: string
  labels: string[]
  outputs: Array<{
    satoshis: number
    lockingScript: string
    outputDescription?: string
    basket?: string
  }>
  options?: {
    acceptDelayedBroadcast?: boolean
    randomizeOutputs?: boolean
  }
}

export function buildDeployEscrowTemplate(opts: {
  snapshot: EscrowSnapshot
  title: string
  category: string
  posterLockingScriptHex?: string
}): CreateActionTemplate {
  const hold =
    opts.posterLockingScriptHex ??
    p2pkhFromPubKeyHex(opts.snapshot.posterPubKey)

  return {
    description: `Deploy AI Bounty escrow: ${opts.title}`,
    labels: [BRC100_LABELS.app, BRC100_LABELS.post, 'escrow:deploy'],
    options: { acceptDelayedBroadcast: false, randomizeOutputs: false },
    outputs: [
      {
        satoshis: opts.snapshot.amountSats,
        lockingScript: hold,
        outputDescription: `Escrow hold (${stateName(opts.snapshot.state)})`,
        basket: 'ai-bounties-escrow',
      },
      {
        satoshis: 0,
        lockingScript: buildEscrowParamScript(opts.snapshot),
        outputDescription: 'Escrow state parameters',
      },
      {
        satoshis: 0,
        lockingScript: buildBountyPostLockingScript({
          bountyId: opts.snapshot.bountyId,
          amountSats: opts.snapshot.amountSats,
          contentHash: opts.snapshot.contentHash,
          category: categoryFromLabel(opts.category) as BountyCategory,
          title: opts.title,
        }),
        outputDescription: 'BOUNTY_POST protocol data',
      },
    ],
  }
}

export function buildTransitionTemplate(opts: {
  current: EscrowSnapshot
  transition: TransitionResult
  method: string
  posterLockingScriptHex?: string
  workerLockingScriptHex?: string
  feeLockingScriptHex?: string
}): CreateActionTemplate {
  const { transition: t, current } = opts
  const labels = [BRC100_LABELS.app, `escrow:${opts.method}`]

  if (t.payout) {
    const outputs: CreateActionTemplate['outputs'] = []
    if (t.payout.type === 'worker' || t.payout.type === 'split') {
      const workerScript =
        opts.workerLockingScriptHex ??
        p2pkhFromPubKeyHex(current.workerPubKey)
      outputs.push({
        satoshis: t.payout.workerSats ?? current.amountSats,
        lockingScript: workerScript,
        outputDescription: 'Pay worker',
      })
      if (t.payout.feeSats && t.payout.feeSats > 0) {
        const feeScript =
          opts.feeLockingScriptHex ??
          (current.feePkh
            ? p2pkhFromPubKeyHex(current.feePkh)
            : p2pkhFromPubKeyHex(current.posterPubKey))
        outputs.push({
          satoshis: t.payout.feeSats,
          lockingScript: feeScript,
          outputDescription: 'Platform fee',
        })
      }
    } else if (t.payout.type === 'poster') {
      const posterScript =
        opts.posterLockingScriptHex ??
        p2pkhFromPubKeyHex(current.posterPubKey)
      outputs.push({
        satoshis: t.payout.posterSats ?? current.amountSats,
        lockingScript: posterScript,
        outputDescription: 'Refund poster',
      })
    }

    outputs.push({
      satoshis: 0,
      lockingScript: buildEscrowParamScript(t.next),
      outputDescription: `Escrow terminal ${stateName(t.next.state)}`,
    })

    return {
      description: `Escrow ${opts.method} → ${stateName(t.next.state)}`,
      labels,
      outputs,
    }
  }

  const hold =
    opts.posterLockingScriptHex ??
    p2pkhFromPubKeyHex(current.posterPubKey)

  return {
    description: `Escrow ${opts.method} → ${stateName(t.next.state)}`,
    labels,
    outputs: [
      {
        satoshis: t.next.amountSats,
        lockingScript: hold,
        outputDescription: `Escrow hold (${stateName(t.next.state)})`,
      },
      {
        satoshis: 0,
        lockingScript: buildEscrowParamScript(t.next),
        outputDescription: 'Updated escrow state',
      },
    ],
  }
}

export function initialSnapshot(opts: {
  bountyId: string
  contentHash: string
  amountSats: number
  posterPubKey: string
  arbiterPubKey?: string
  deadline?: number
  feeBps?: number
  feePkh?: string
}): EscrowSnapshot {
  return {
    state: EscrowState.OPEN,
    amountSats: opts.amountSats,
    bountyId: opts.bountyId,
    contentHash: opts.contentHash,
    posterPubKey: opts.posterPubKey,
    workerPubKey: '',
    arbiterPubKey: opts.arbiterPubKey ?? '',
    deadline: opts.deadline ?? 0,
    workHash: '',
    feeBps: opts.feeBps ?? 0,
    feePkh: opts.feePkh ?? '',
  }
}

export { feeAmount }
