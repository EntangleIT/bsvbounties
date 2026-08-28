import { BSM, PublicKey, Signature } from '@bsv/sdk'

/** Compressed secp256k1 pubkey hex (33 bytes). */
export function isCompressedPubKeyHex(key: string): boolean {
  const clean = key.trim().replace(/^0x/, '')
  return /^(02|03)[0-9a-fA-F]{64}$/.test(clean)
}

export function normalizePubKeyHex(key: string): string {
  return key.trim().replace(/^0x/, '').toLowerCase()
}

/**
 * Verify a Bitcoin Signed Message (compact base64) against a compressed pubkey.
 * Used for Yours / BRC-100 `signBsm` logins.
 */
export function verifyBsmSignature(
  message: string,
  pubKeyHex: string,
  signature: string,
): boolean {
  try {
    const pubKey = PublicKey.fromString(normalizePubKeyHex(pubKeyHex))
    const sig = Signature.fromCompact(signature.trim(), 'base64')
    const messageBytes = Array.from(new TextEncoder().encode(message))
    return BSM.verify(messageBytes, sig, pubKey)
  } catch {
    return false
  }
}
