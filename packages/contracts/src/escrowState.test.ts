import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  EscrowState,
  applyTransition,
  feeAmount,
  type EscrowSnapshot,
} from './escrowState.js'
import { initialSnapshot } from './templates.js'

function base(): EscrowSnapshot {
  return initialSnapshot({
    bountyId: 'aabbccddeeff00112233445566778899',
    contentHash: '11'.repeat(32),
    amountSats: 100_000,
    posterPubKey: '02poster',
    arbiterPubKey: '03arbiter',
    deadline: 2_000_000_000,
    feeBps: 200,
    feePkh: 'aa'.repeat(20),
  })
}

describe('BountyEscrow state machine', () => {
  it('claim → submit → approve with fee split', () => {
    let s = base()
    let r = applyTransition(s, {
      method: 'claim',
      signerPubKey: '02worker',
      workerPubKey: '02worker',
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    s = r.next
    assert.equal(s.state, EscrowState.CLAIMED)

    r = applyTransition(s, {
      method: 'submit',
      signerPubKey: '02worker',
      workHash: 'ab'.repeat(32),
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    s = r.next
    assert.equal(s.state, EscrowState.SUBMITTED)

    r = applyTransition(s, {
      method: 'approve',
      signerPubKey: '02poster',
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.next.state, EscrowState.PAID)
    assert.equal(r.payout?.workerSats, 98_000)
    assert.equal(r.payout?.feeSats, 2_000)
  })

  it('poster can cancel open bounty', () => {
    const s = base()
    const r = applyTransition(s, {
      method: 'cancel',
      signerPubKey: '02poster',
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.next.state, EscrowState.REFUNDED)
    assert.equal(r.payout?.posterSats, 100_000)
  })

  it('refund before deadline fails', () => {
    let s = base()
    const c = applyTransition(s, {
      method: 'claim',
      signerPubKey: '02worker',
    })
    assert.ok(c.ok)
    if (!c.ok) return
    s = c.next
    const r = applyTransition(s, {
      method: 'refund',
      signerPubKey: '02poster',
      now: 1_000,
    })
    assert.equal(r.ok, false)
  })

  it('arbiter resolve to worker', () => {
    let s = base()
    const c = applyTransition(s, {
      method: 'claim',
      signerPubKey: '02worker',
    })
    assert.ok(c.ok)
    if (!c.ok) return
    s = c.next
    const r = applyTransition(s, {
      method: 'resolve',
      signerPubKey: '03arbiter',
      payWorker: true,
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.next.state, EscrowState.PAID)
  })

  it('verifier can auto-approve submitted work', () => {
    let s = base()
    const c = applyTransition(s, {
      method: 'claim',
      signerPubKey: '02worker',
    })
    assert.ok(c.ok)
    if (!c.ok) return
    s = c.next
    const sub = applyTransition(s, {
      method: 'submit',
      signerPubKey: '02worker',
      workHash: 'ab'.repeat(32),
    })
    assert.ok(sub.ok)
    if (!sub.ok) return
    const r = applyTransition(sub.next, {
      method: 'approve',
      signerPubKey: 'ai-bounties-verifier-v1',
      asVerifier: true,
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.next.state, EscrowState.PAID)
  })

  it('non-poster cannot approve without asVerifier', () => {
    let s = base()
    const c = applyTransition(s, {
      method: 'claim',
      signerPubKey: '02worker',
    })
    assert.ok(c.ok)
    if (!c.ok) return
    const r = applyTransition(c.next, {
      method: 'approve',
      signerPubKey: '02worker',
    })
    assert.equal(r.ok, false)
  })

  it('feeAmount calc', () => {
    assert.equal(feeAmount(100_000, 200), 2_000)
    assert.equal(feeAmount(100_000, 0), 0)
  })
})
