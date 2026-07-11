import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex as nobleBytesToHex, hexToBytes as nobleHexToBytes } from '@noble/hashes/utils.js'
import type { BountyContent } from './types.js'

/** Stable JSON for hashing (sorted keys, no whitespace variance). */
export function canonicalizeContent(content: BountyContent): string {
  const ordered: BountyContent = {
    category: content.category,
    description: content.description,
    requirements: content.requirements ?? [],
    title: content.title,
    version: 1,
  }
  return JSON.stringify(ordered)
}

export function sha256Hex(data: string | Uint8Array): string {
  const bytes =
    typeof data === 'string' ? new TextEncoder().encode(data) : data
  return nobleBytesToHex(sha256(bytes))
}

export function contentHash(content: BountyContent): string {
  return sha256Hex(canonicalizeContent(content))
}

/** 16-byte bounty id as hex (32 chars). */
export function generateBountyId(): string {
  const buf = new Uint8Array(16)
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(buf)
  } else {
    for (let i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256)
  }
  return nobleBytesToHex(buf)
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  return nobleHexToBytes(clean)
}

export function bytesToHex(bytes: Uint8Array): string {
  return nobleBytesToHex(bytes)
}
