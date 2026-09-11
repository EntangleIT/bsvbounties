import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  effectiveApprovalThreshold,
  trustBondDiscountBps,
  trustGateForClaim,
  trustGateForPay,
} from './trust.js'

describe('trustGateForClaim (spend -> work)', () => {
  const old = new Date(Date.now() - 8 * 86_400_000).toISOString()
  const base = {
    v: 1,
    iss: 'agentpay.entangleit.com',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    metrics: {
      settledPayments: 10,
      distinctServices: 3,
      distinctPayTo: 3,
      spentCents: 100,
      refundedCents: 0,
      firstPaymentAt: old,
    },
  }
  it('eligible at threshold (10 pays, 3 services/payees, 50c+, 7d+, no refunds)', () => {
    const d = trustGateForClaim(base)
    assert.equal(d.eligible, true)
    assert.equal(d.reason, 'trusted_spender')
    assert.equal(trustBondDiscountBps(true, false), 5000)
    assert.equal(trustBondDiscountBps(true, true), 10000)
    assert.equal(trustBondDiscountBps(false, true), 0)
  })
  it('wash fails: 100 pays on 1 service', () => {
    const d = trustGateForClaim({
      ...base,
      metrics: { ...base.metrics, settledPayments: 100, distinctServices: 1, distinctPayTo: 1 },
    })
    assert.equal(d.eligible, false)
    assert.equal(d.reason, 'too_few_services')
  })
  it('wash fails: 3 services, 1 payee', () => {
    const d = trustGateForClaim({
      ...base,
      metrics: { ...base.metrics, distinctPayTo: 1 },
    })
    assert.equal(d.eligible, false)
    assert.equal(d.reason, 'too_few_payees')
  })
  it('cheap wash fails: spend floor', () => {
    const d = trustGateForClaim({
      ...base,
      metrics: { ...base.metrics, spentCents: 10 },
    })
    assert.equal(d.eligible, false)
    assert.equal(d.reason, 'spend_too_low')
  })
  it('new wallet fails: age floor', () => {
    const d = trustGateForClaim({
      ...base,
      metrics: { ...base.metrics, firstPaymentAt: new Date().toISOString() },
    })
    assert.equal(d.eligible, false)
    assert.equal(d.reason, 'wallet_too_new')
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
