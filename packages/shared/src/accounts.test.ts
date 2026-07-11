import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { authMessage, AccountAction } from './accounts.js'
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
