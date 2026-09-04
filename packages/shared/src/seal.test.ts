import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendSealEvent,
  createSubmitSeal,
  GENESIS_PREV_HASH,
  verifySealChain,
  verifySealEnvelope,
  type SealEnvelope,
} from './seal.js'
import { verifyWork } from './verify.js'

const WORK = 'cd'.repeat(32)

function sealedInput(seal: SealEnvelope, extra = {}) {
  return {
    acceptance: { kind: 'sealed' as const },
    workHash: WORK,
    seal,
    ...extra,
  }
}

describe('seal custody chain', () => {
  it('round-trips create → verify', () => {
    const seal = createSubmitSeal({
      workHash: WORK,
      submitter: { controllerKey: 'key-1', accountNumber: 7 },
    })
    assert.equal(seal.events.length, 1)
    assert.equal(seal.events[0]!.prevHash, GENESIS_PREV_HASH)
    const chain = verifySealChain(seal.events)
    assert.equal(chain.ok, true)
    assert.ok(chain.tip)
    const v = verifySealEnvelope(seal, { expectedWorkHash: WORK })
    assert.equal(v.ok, true)
    assert.equal(v.reason, 'sealed_chain_valid')
  })

  it('detects tampering with index', () => {
    const seal = createSubmitSeal({ workHash: WORK, submitter: {} })
    const tampered: SealEnvelope = {
      ...seal,
      events: seal.events.map((e) => ({ ...e, actorName: 'mallory' })),
    }
    const chain = verifySealChain(tampered.events)
    assert.equal(chain.ok, false)
    assert.equal(chain.index, 0)
    assert.equal(chain.reason, 'seal_event_hash_mismatch')
  })

  it('detects broken linkage on append', () => {
    const seal = createSubmitSeal({ workHash: WORK, submitter: {} })
    const tip = seal.events[0]!.eventHash
    const second = appendSealEvent({
      prevHash: 'ff'.repeat(32),
      type: 'STAMPED',
      actorId: 'x',
      actorName: 'x',
      contentHash: WORK,
    })
    void tip
    const chain = verifySealChain([...seal.events, second])
    assert.equal(chain.ok, false)
    assert.equal(chain.reason, 'seal_broken_link')
  })

  it('rejects hash mismatch and bad shapes', () => {
    const seal = createSubmitSeal({ workHash: WORK, submitter: {} })
    assert.equal(
      verifySealEnvelope(seal, { expectedWorkHash: 'ab'.repeat(32) }).reason,
      'seal_hash_mismatch',
    )
    assert.equal(
      verifySealEnvelope({ ...seal, version: 99 }).reason,
      'seal_bad_version',
    )
    assert.equal(
      verifySealEnvelope({ ...seal, events: [] }).reason,
      'seal_empty_chain',
    )
  })

  it('binds the envelope to the authenticated submitter', () => {
    const seal = createSubmitSeal({
      workHash: WORK,
      submitter: { controllerKey: 'key-1' },
    })
    assert.equal(
      verifySealEnvelope(seal, {
        expectedSubmitter: { controllerKey: 'key-2' },
      }).reason,
      'seal_actor_mismatch',
    )
    assert.equal(
      verifySealEnvelope(seal, {
        expectedSubmitter: { controllerKey: 'key-1' },
      }).ok,
      true,
    )
  })
})

describe('sealed acceptance', () => {
  it('fails closed without an envelope', async () => {
    const v = await verifyWork({
      acceptance: { kind: 'sealed' },
      workHash: WORK,
    })
    assert.equal(v.passed, false)
    assert.equal(v.reason, 'seal_missing')
  })

  it('passes a valid chain without timestamp', async () => {
    const seal = createSubmitSeal({ workHash: WORK, submitter: {} })
    const v = await verifyWork(sealedInput(seal))
    assert.equal(v.passed, true)
    assert.equal(v.reason, 'sealed_chain_valid')
  })

  it('fails a tampered envelope (hard, not soft)', async () => {
    const seal = createSubmitSeal({ workHash: WORK, submitter: {} })
    seal.events[0]!.actorName = 'mallory'
    const v = await verifyWork(sealedInput(seal))
    assert.equal(v.passed, false)
    assert.equal(v.reason, 'seal_event_hash_mismatch')
  })

  it('platform-stamps when the poster requires a timestamp', async () => {
    const seal = createSubmitSeal({ workHash: WORK, submitter: {} })
    const stamp = {
      tsa: 'TestTSA',
      tsaUrl: 'https://tsa.example.com',
      hashedMessage: WORK,
      genTime: new Date().toISOString(),
      tokenB64: 'dGVzdA==',
      serial: '01',
      status: 0,
    }
    const v = await verifyWork(
      {
        acceptance: { kind: 'sealed', requireTimestamp: true },
        workHash: WORK,
        seal,
      },
      { stamp: async () => stamp },
    )
    assert.equal(v.passed, true)
    assert.equal(v.reason, 'sealed_platform_timestamp')
    assert.deepEqual(
      (v.details as { stamp: unknown }).stamp,
      stamp,
    )
  })

  it('fails soft when timestamping is unavailable', async () => {
    const seal = createSubmitSeal({ workHash: WORK, submitter: {} })
    const v = await verifyWork(
      {
        acceptance: { kind: 'sealed', requireTimestamp: true },
        workHash: WORK,
        seal,
      },
      {
        stamp: async () => {
          throw new Error('Could not obtain an RFC 3161 timestamp (down)')
        },
      },
    )
    assert.equal(v.passed, false)
    assert.equal(v.reason, 'timestamp_unavailable')
  })

  it('rejects malformed worker-supplied tokens', async () => {
    const seal = createSubmitSeal({ workHash: WORK, submitter: {} })
    seal.rfc3161 = {
      tsa: 'FakeTSA',
      tsaUrl: 'https://tsa.example.com',
      hashedMessage: WORK,
      genTime: new Date().toISOString(),
      tokenB64: 'dGVzdA==', // not DER — structural check must fail closed
      serial: '01',
      status: 0,
    }
    const v = await verifyWork({
      acceptance: { kind: 'sealed', requireTimestamp: true },
      workHash: WORK,
      seal,
    })
    assert.equal(v.passed, false)
    assert.equal(v.reason, 'seal_bad_token')
  })
})
