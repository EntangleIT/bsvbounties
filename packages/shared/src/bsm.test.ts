import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BSM, PrivateKey, Signature } from '@bsv/sdk'
import {
  isCompressedPubKeyHex,
  verifyBsmSignature,
} from './bsm.js'

describe('BSM wallet signatures', () => {
  it('accepts a compact signature from the matching key', () => {
    const priv = PrivateKey.fromRandom()
    const pub = priv.toPublicKey().toString()
    assert.equal(isCompressedPubKeyHex(pub), true)
    const message = 'aibounties-auth-v1:deadbeef'
    const messageBytes = Array.from(new TextEncoder().encode(message))
    const sigB64 = BSM.sign(messageBytes, priv, 'base64') as string
    assert.equal(verifyBsmSignature(message, pub, sigB64), true)
    assert.equal(verifyBsmSignature(message + 'x', pub, sigB64), false)
    const other = PrivateKey.fromRandom().toPublicKey().toString()
    assert.equal(verifyBsmSignature(message, other, sigB64), false)
    // Demo hex sha256 is not a BSM compact sig
    assert.equal(verifyBsmSignature(message, pub, 'ab'.repeat(32)), false)
    // fromCompact round-trip still verifies
    const raw = Signature.fromCompact(sigB64, 'base64')
    assert.ok(raw)
  })
})
