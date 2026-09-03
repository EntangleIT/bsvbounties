import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeTimeStampReq,
  parseAsn1Time,
  parseDerRoot,
  randomNonce,
} from './rfc3161.js'

describe('RFC 3161 request', () => {
  it('encodes a SHA-256 TimeStampReq', () => {
    const hash = 'ab'.repeat(32)
    const der = encodeTimeStampReq(hash, randomNonce())
    assert.equal(der[0], 0x30)
    const root = parseDerRoot(der)
    assert.equal(root.children.length, 4)
    assert.equal(root.children[0]!.tag, 0x02)
    assert.equal(root.children[3]!.tag, 0x01)
  })

  it('rejects non-SHA-256 digests', () => {
    assert.throws(() => encodeTimeStampReq('abcd', randomNonce()), /SHA-256/)
  })

  it('parses GeneralizedTime and UTCTime', () => {
    assert.equal(parseAsn1Time('20260830184500Z'), '2026-08-30T18:45:00.000Z')
    assert.equal(parseAsn1Time('260830184500Z'), '2026-08-30T18:45:00.000Z')
  })
})

describe('public TSA (live, opt-in)', () => {
  it(
    'returns a parseable RFC 3161 token',
    { skip: !process.env.RUN_TSA } as never,
    async () => {
      const { requestRfc3161 } = await import('./rfc3161.js')
      const stamp = await requestRfc3161('ab'.repeat(32))
      assert.match(stamp.tsa, /DigiCert|Sectigo|FreeTSA/)
      assert.equal(stamp.hashedMessage, 'ab'.repeat(32))
      assert.ok(stamp.tokenB64.length > 80)
      assert.match(stamp.genTime, /^\d{4}-/)
    },
  )
})
