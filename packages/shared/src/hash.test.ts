import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalizeContent, contentHash, generateBountyId } from './hash.js'

describe('content hashing', () => {
  it('is stable for same logical content', () => {
    const a = contentHash({
      version: 1,
      title: 'Fix bug',
      description: 'Reproduce and fix',
      category: 'dev',
      requirements: ['PR', 'tests'],
    })
    const b = contentHash({
      version: 1,
      title: 'Fix bug',
      description: 'Reproduce and fix',
      category: 'dev',
      requirements: ['PR', 'tests'],
    })
    assert.equal(a, b)
    assert.equal(a.length, 64)
  })

  it('canonical form sorts keys', () => {
    const s = canonicalizeContent({
      version: 1,
      title: 't',
      description: 'd',
      category: 'dev',
    })
    assert.ok(s.startsWith('{"category"'))
  })

  it('generates 32-char hex ids', () => {
    const id = generateBountyId()
    assert.equal(id.length, 32)
    assert.match(id, /^[0-9a-f]+$/)
  })
})
