import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  effectiveApprovalThreshold,
  trustGateForClaim,
  trustGateForPay,
} from './trust.js'

describe('trustGateForClaim (spend -> work)', () => {
  const base = {
    v: 1,
    iss: 'agentpay.entangleit.com',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    metrics: { settledPayments: 10, distinctServices: 3, spentCents: 100, refundedCents: 0 },
  }
  it('eligible at threshold (10 pays, 3 services, no refunds)', () => {
    const d = trustGateForClaim(base)
    assert.equal(d.eligible, true)
    assert.equal(d.reason, 'trusted_spender')
  })
  it('wash fails: 100 pays on 1 service', () => {
    const d = trustGateForClaim({
      ...base,
      metrics: { settledPayments: 100, distinctServices: 1, spentCents: 500, refundedCents: 0 },
    })
    assert.equal(d.eligible, false)
    assert.equal(d.reason, 'too_few_services')
  })
  it('refunds fail closed', () => {
    const d = trustGateForClaim({
      ...base,
      metrics: { settledPayments: 20, distinctServices: 5, spentCents: 200, refundedCents: 5 },
    })
    assert.equal(d.eligible, false)
    assert.equal(d.reason, 'has_refunds')
  })
  it('expired fails closed', () => {
    const d = trustGateForClaim({
      ...base,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    assert.equal(d.eligible, false)
  })
})

describe('trustGateForPay (work -> spend)', () => {
  it('fast-path at 650, no slashes, non-provisional', () => {
    const d = trustGateForPay({ score: 700, provisional: false, slashes: 0 })
    assert.equal(d.fastPath, true)
    assert.equal(effectiveApprovalThreshold(100, d), 200)
  })
  it('provisional never fast-paths', () => {
    const d = trustGateForPay({ score: 900, provisional: true, slashes: 0 })
    assert.equal(d.fastPath, false)
  })
  it('slashes fail closed', () => {
    const d = trustGateForPay({ score: 800, provisional: false, slashes: 1 })
    assert.equal(d.fastPath, false)
  })
  it('null threshold stays null (never raises limits)', () => {
    const d = trustGateForPay({ score: 800, provisional: false, slashes: 0 })
    assert.equal(effectiveApprovalThreshold(null, d), null)
  })
})
