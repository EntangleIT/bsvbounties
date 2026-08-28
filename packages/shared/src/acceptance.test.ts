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
  formatVerificationReason,
  normalizeWorkFetchUrl,
  isSoftVerification,
} from './acceptance.js'
import { verifyWork } from './verify.js'
import { contentHash, sha256Hex } from './hash.js'

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
    assert.equal(isAutoRelease({ kind: 'hash' }), true)
    assert.equal(parseAcceptance({ kind: 'schema', schema: {} }).kind, 'schema')
    assert.equal(parseAcceptance({ kind: 'hash' }).kind, 'hash')
    assert.equal(parseAcceptance({}).kind, 'manual')
  })

  it('rewrites Drive view URLs to uc?export=download', () => {
    assert.equal(
      normalizeWorkFetchUrl('https://drive.google.com/file/d/abc/view?usp=sharing'),
      'https://drive.google.com/uc?export=download&id=abc',
    )
    assert.equal(
      normalizeWorkFetchUrl('https://drive.google.com/open?id=xyz'),
      'https://drive.google.com/uc?export=download&id=xyz',
    )
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

  it('soft verification reasons', () => {
    assert.equal(
      isSoftVerification({ passed: false, reason: 'manual_approval_required' }),
      true,
    )
    assert.equal(
      isSoftVerification({ passed: false, reason: 'llm_credits_exhausted' }),
      true,
    )
    assert.equal(isSoftVerification({ passed: false, reason: 'hash_mismatch' }), false)
  })
})

describe('verifyWork', () => {
  it('manual never auto-passes', async () => {
    const v = await verifyWork({ acceptance: { kind: 'manual' } })
    assert.equal(v.passed, false)
    assert.equal(v.reason, 'manual_approval_required')
    assert.equal(isSoftVerification(v), true)
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

  it('http jsonPath fails on HTML (e.g. Google Drive viewer)', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response('<!doctype html><html><body>Drive</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    const v = await verifyWork(
      {
        acceptance: { kind: 'http', jsonPath: 'ok', expect: true },
        workUri: 'https://drive.google.com/file/d/abc123/view?usp=sharing',
      },
      { fetch: fetchMock },
    )
    assert.equal(v.passed, false)
    assert.equal(v.reason, 'http_not_for_drive')
    assert.match(formatVerificationReason(v), /hash|llm-judge/i)
  })

  it('http contentTypePrefix accepts an image', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    const v = await verifyWork(
      {
        acceptance: { kind: 'http', contentTypePrefix: 'image/' },
        workUri: 'https://example.com/logo.png',
      },
      { fetch: fetchMock },
    )
    assert.equal(v.passed, true, v.reason)
  })

  it('rewrites Google Drive view links to the download endpoint', async () => {
    let fetched: string | undefined
    const fetchMock: typeof fetch = async (input) => {
      fetched = String(input)
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    }
    await verifyWork(
      {
        acceptance: { kind: 'http', contentTypePrefix: 'image/' },
        workUri: 'https://drive.google.com/file/d/FILEID99/view?usp=sharing',
      },
      { fetch: fetchMock },
    )
    assert.equal(
      fetched,
      'https://drive.google.com/uc?export=download&id=FILEID99',
    )
  })

  it('hash passes when workHash matches body bytes', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
    const digest = sha256Hex(bytes)
    const fetchMock: typeof fetch = async () =>
      new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    const v = await verifyWork(
      {
        acceptance: { kind: 'hash' },
        workUri: 'https://example.com/logo.png',
        workHash: digest,
      },
      { fetch: fetchMock },
    )
    assert.equal(v.passed, true, v.reason)
    assert.equal(v.reason, 'artifact_hash_matched')
  })

  it('hash fails on mismatch', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    const v = await verifyWork(
      {
        acceptance: { kind: 'hash' },
        workUri: 'https://example.com/blob.bin',
        workHash: '0'.repeat(64),
      },
      { fetch: fetchMock },
    )
    assert.equal(v.passed, false)
    assert.equal(v.reason, 'hash_mismatch')
  })

  it('hash rejects HTML viewer pages', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response('<!doctype html><html><body>viewer</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    const v = await verifyWork(
      {
        acceptance: { kind: 'hash' },
        workUri: 'https://drive.google.com/file/d/abc/view',
        workHash: 'a'.repeat(64),
      },
      { fetch: fetchMock },
    )
    assert.equal(v.passed, false)
    assert.equal(v.reason, 'html_not_artifact')
  })

  it('command kind aliases hash', async () => {
    const bytes = new TextEncoder().encode('artifact-bytes')
    const digest = sha256Hex(bytes)
    const fetchMock: typeof fetch = async () =>
      new Response(bytes, { status: 200, headers: { 'content-type': 'text/plain' } })
    const v = await verifyWork(
      {
        acceptance: { kind: 'command' },
        workUri: 'https://example.com/a.txt',
        workHash: digest,
      },
      { fetch: fetchMock },
    )
    assert.equal(v.passed, true, v.reason)
  })

  it('llm-judge mocked pass', async () => {
    const v = await verifyWork(
      {
        acceptance: { kind: 'llm-judge', rubric: 'Must be a logo', passScore: 0.5 },
        workUri: 'https://example.com/logo.png',
        requirements: ['square logo'],
        title: 'Logo',
        description: 'Make a logo',
      },
      {
        fetch: async () =>
          new Response(new Uint8Array([1, 2]), {
            status: 200,
            headers: { 'content-type': 'image/png' },
          }),
        llmJudge: async (input) => {
          assert.match(input.spec.rubric ?? '', /logo/i)
          return { pass: true, score: 0.9, reason: 'looks good' }
        },
      },
    )
    assert.equal(v.passed, true, v.reason)
    assert.equal(v.score, 0.9)
  })

  it('llm-judge credits exhausted is soft failure', async () => {
    const v = await verifyWork(
      {
        acceptance: { kind: 'llm-judge' },
        notes: 'work notes',
        title: 't',
        description: 'd',
      },
      {
        llmJudge: async () => {
          throw new Error('LLM xai error 429: credits exhausted')
        },
      },
    )
    assert.equal(v.passed, false)
    assert.equal(v.reason, 'llm_credits_exhausted')
    assert.equal(isSoftVerification(v), true)
  })
})
