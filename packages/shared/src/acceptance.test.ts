import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getJsonPath,
  validateJsonSchema,
  validateMilestones,
  initMilestones,
  median,
  isAutoRelease,
  parseAcceptance,
} from './acceptance.js'
import { verifyWork } from './verify.js'
import { contentHash } from './hash.js'

describe('acceptance helpers', () => {
  it('jsonPath walks nested objects', () => {
    assert.equal(getJsonPath({ ok: true, nested: { a: 1 } }, 'ok'), true)
    assert.equal(getJsonPath({ ok: true, nested: { a: 1 } }, 'nested.a'), 1)
    assert.equal(getJsonPath({ ok: true }, 'missing'), undefined)
  })

  it('validates a small JSON schema', () => {
    const schema = {
      type: 'object',
      required: ['ok'],
      properties: { ok: { type: 'boolean', const: true } },
    }
    assert.equal(validateJsonSchema(schema, { ok: true }).ok, true)
    assert.equal(validateJsonSchema(schema, { ok: false }).ok, false)
    assert.equal(validateJsonSchema(schema, {}).ok, false)
  })

  it('rejects milestone sums that do not match', () => {
    const acc = { kind: 'http' as const, jsonPath: 'ok', expect: true }
    assert.equal(
      validateMilestones(100, [
        { amountSats: 40, acceptance: acc },
        { amountSats: 60, acceptance: acc },
      ]),
      null,
    )
    assert.equal(
      validateMilestones(100, [{ amountSats: 40, acceptance: acc }]),
      'milestones_sum_mismatch',
    )
    assert.equal(initMilestones([{ amountSats: 100, acceptance: acc }])[0]?.status, 'pending')
  })

  it('median of even/odd lists', () => {
    assert.equal(median([]), null)
    assert.equal(median([3]), 3)
    assert.equal(median([1, 3, 5]), 3)
    assert.equal(median([1, 2, 3, 4]), 2)
  })

  it('auto-release only for non-manual specs', () => {
    assert.equal(isAutoRelease({ kind: 'manual' }), false)
    assert.equal(isAutoRelease({ kind: 'http' }), true)
    assert.equal(parseAcceptance({ kind: 'schema', schema: {} }).kind, 'schema')
    assert.equal(parseAcceptance({}).kind, 'manual')
  })

  it('content hash unchanged without acceptance', () => {
    const a = contentHash({
      version: 1,
      title: 'Fix bug',
      description: 'Reproduce and fix',
      category: 'dev',
      requirements: ['PR', 'tests'],
    })
    assert.equal(a.length, 64)
  })
})

describe('verifyWork', () => {
  it('manual never auto-passes', async () => {
    const v = await verifyWork({ acceptance: { kind: 'manual' } })
    assert.equal(v.passed, false)
    assert.equal(v.reason, 'manual_approval_required')
  })

  it('http checks status, jsonPath, and regex', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    const v = await verifyWork(
      {
        acceptance: {
          kind: 'http',
          jsonPath: 'ok',
          expect: true,
          regex: '"ok"',
        },
        workUri: 'http://127.0.0.1:9/health',
      },
      { fetch: fetchMock },
    )
    assert.equal(v.passed, true, v.reason)
  })

  it('http fails on wrong jsonPath', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: false }), { status: 200 })
    const v = await verifyWork(
      {
        acceptance: { kind: 'http', jsonPath: 'ok', expect: true },
        workUri: 'http://127.0.0.1:9/health',
      },
      { fetch: fetchMock },
    )
    assert.equal(v.passed, false)
  })

  it('schema validates fetched JSON', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ digest: 'abc' }), { status: 200 })
    const v = await verifyWork(
      {
        acceptance: {
          kind: 'schema',
          schema: {
            type: 'object',
            required: ['digest'],
            properties: { digest: { type: 'string' } },
          },
        },
        workUri: 'https://example.com/artifact.json',
      },
      { fetch: fetchMock },
    )
    assert.equal(v.passed, true, v.reason)
  })

  it('rejects non-http URLs', async () => {
    const v = await verifyWork({
      acceptance: { kind: 'http' },
      workUri: 'file:///etc/passwd',
    })
    assert.equal(v.passed, false)
    assert.equal(v.reason, 'unsupported_url_scheme')
  })
})
