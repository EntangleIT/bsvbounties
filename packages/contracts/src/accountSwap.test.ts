import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAtomicAccountSwapTemplate,
  buildBondDepositTemplate,
} from './accountSwap.js'

describe('atomic account swap + bond templates', () => {
  it('builds 3 outputs for atomic swap', () => {
    const t = buildAtomicAccountSwapTemplate({
      accountNumber: 33,
      priceSats: 100_000_000,
      sellerControllerKey: 'seller-key',
      buyerControllerKey: 'buyer-key',
    })
    assert.equal(t.outputs.length, 3)
    assert.equal(t.outputs[0]!.satoshis, 100_000_000)
    assert.equal(t.outputs[1]!.satoshis, 1)
    assert.equal(t.outputs[2]!.satoshis, 0)
    assert.ok(t.labels.includes('account:atomic-swap'))
  })

  it('builds bond deposit template', () => {
    const t = buildBondDepositTemplate({
      amountSats: 50_000,
      controllerKey: 'poster-key',
    })
    assert.equal(t.outputs[0]!.satoshis, 50_000)
    assert.ok(t.labels.includes('bond:deposit'))
  })
})
