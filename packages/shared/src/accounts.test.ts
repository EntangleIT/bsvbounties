import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { authMessage, AccountAction, reputationScore, reputationOf } from './accounts.js'
import {
  decodeAccountMintPayload,
  encodeAccountMintPayload,
  encodeProtocolMessage,
  decodeProtocolMessage,
} from './opreturn.js'
import { contentHash, sha256Hex } from './hash.js'

describe('account protocol', () => {
  it('round-trips ACCOUNT_MINT payload', () => {
    const controllerKeyHash = sha256Hex('demo-identity-key')
    const payload = encodeAccountMintPayload({
      accountNumber: 33,
      controllerKeyHash,
      kind: 0,
      nameLen: 0,
      displayName: 'Alice',
    })
    const decoded = decodeAccountMintPayload(payload)
    assert.equal(decoded.accountNumber, 33)
    assert.equal(decoded.controllerKeyHash, controllerKeyHash)
    assert.equal(decoded.displayName, 'Alice')

    const msg = encodeProtocolMessage(AccountAction.MINT, payload)
    const outer = decodeProtocolMessage(msg)
    assert.equal(outer.action, AccountAction.MINT)
  })

  it('auth message is stable', () => {
    assert.equal(authMessage('abc'), 'aibounties-auth-v1:abc')
  })

  it('content hash still works', () => {
    assert.equal(
      contentHash({
        version: 1,
        title: 't',
        description: 'd',
        category: 'dev',
      }).length,
      64,
    )
  })
})

describe('reputation score v1', () => {
  it('cold start is provisional mid-table', () => {
    const r = reputationScore(undefined)
    assert.equal(r.score, 500)
    assert.equal(r.tier, 'B')
    assert.equal(r.provisional, true)
  })

  it('orders perfect > newcomer > sloppy > slashed', () => {
    const perfect = reputationScore({
      bountiesCompleted: 10,
      verifiesPassed: 20,
      verifiesFailed: 0,
      submitDurationsMs: [1_000_000],
    })
    const newcomer = reputationScore(undefined)
    const sloppy = reputationScore({ verifiesPassed: 2, verifiesFailed: 8 })
    const slashed = reputationScore({
      bountiesCompleted: 5,
      verifiesPassed: 5,
      verifiesFailed: 5,
      slashes: 2,
    })
    assert.ok(perfect.score > newcomer.score)
    assert.ok(newcomer.score > sloppy.score)
    assert.ok(sloppy.score > slashed.score)
    assert.equal(perfect.provisional, false)
    assert.ok(['S', 'A'].includes(perfect.tier))
  })

  it('verified bonus applies and confidence scales quality', () => {
    const a = reputationScore({ verifiesPassed: 1, verifiesFailed: 0 })
    const b = reputationScore(
      { verifiesPassed: 1, verifiesFailed: 0 },
      { verified: true },
    )
    assert.equal(b.score - a.score, 25)
    // One lucky pass moves the needle less than twenty consistent ones.
    const lucky = reputationScore({ verifiesPassed: 1, verifiesFailed: 0 })
    const proven = reputationScore({ verifiesPassed: 20, verifiesFailed: 0 })
    assert.ok(proven.contributions.quality > lucky.contributions.quality)
  })

  it('clamps at bounds and rewards the number, not the key', () => {
    const worst = reputationScore({ slashes: 50 })
    assert.equal(worst.score, 0)
    assert.equal(worst.tier, 'D')
    const base = {
      number: 33,
      controllerKey: 'old-key',
      displayName: '#33',
      bio: '',
      kind: 'human' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      network: 'test' as const,
      skills: [],
      capabilities: [],
      stats: {
        bountiesPosted: 0,
        bountiesCompleted: 4,
        bountiesClaimed: 4,
        verifiesPassed: 4,
        verifiesFailed: 0,
        slashes: 0,
        submitDurationsMs: [],
      },
    }
    const before = reputationOf(base).score
    // Transfer changes the key; the number keeps its score.
    const after = reputationOf({ ...base, controllerKey: 'new-key' }).score
    assert.equal(before, after)
    assert.ok(before > 500)
  })
})
