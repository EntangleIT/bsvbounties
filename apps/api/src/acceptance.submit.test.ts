import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createLlmFromEnv, type LlmClient, type LlmChatRequest } from '@ai-bounties/llm'
import { sha256Hex } from '@ai-bounties/shared'
import { createApp } from './app.js'
import { AccountStore } from './store/accountStore.js'
import { BondStore } from './store/bondStore.js'
import { BountyStore } from './store/bountyStore.js'
import type { JsonPersist } from './store/persist.js'
import { ChallengeStore, SessionStore } from './store/sessionStore.js'

function memoryPersist(): JsonPersist {
  let data: string | null = null
  return {
    async read() {
      return data
    },
    async write(next) {
      data = next
    },
  }
}

function demoSig(message: string, controllerKey: string): string {
  return createHash('sha256')
    .update(`${message}:${controllerKey}`)
    .digest('hex')
}

describe('acceptance submit + auth hint', () => {
  let app: ReturnType<typeof createApp>
  let bountyStore: BountyStore
  let mockLlm: LlmClient
  let llmPass = true

  before(async () => {
    process.env.AUTH_MODE = 'both'
    process.env.ESCROW_MODE = 'app'
    process.env.REQUIRE_POSTER_BOND = 'false'
    process.env.REQUIRE_ACCOUNT_FOR_CLAIM = 'false'
    bountyStore = new BountyStore(memoryPersist())
    const accounts = new AccountStore(memoryPersist())
    const sessions = new SessionStore(memoryPersist())
    const challenges = new ChallengeStore(memoryPersist())
    const bonds = new BondStore(memoryPersist())
    await Promise.all([
      bountyStore.init(),
      accounts.init(),
      sessions.init(),
      challenges.init(),
      bonds.init(),
    ])
    mockLlm = {
      config: { provider: 'mock', model: 'test' },
      async chat(req: LlmChatRequest) {
        const system = req.messages.find((m) => m.role === 'system')?.content ?? ''
        if (system.includes('You score a work submission')) {
          return {
            content: JSON.stringify({
              pass: llmPass,
              score: llmPass ? 0.95 : 0.1,
              reason: llmPass ? 'mock pass' : 'mock fail',
              fraud: false,
            }),
            provider: 'mock' as const,
            model: 'test',
          }
        }
        return createLlmFromEnv({ LLM_PROVIDER: 'mock' }).chat(req)
      },
    }
    app = createApp({
      publicUrl: 'http://localhost:8787',
      webOrigins: ['http://localhost:5173'],
      network: 'test',
      llm: mockLlm,
      stores: { bounties: bountyStore, accounts, sessions, challenges, bonds },
    })
  })

  async function json(
    path: string,
    init?: RequestInit & { token?: string },
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const headers = new Headers(init?.headers)
    headers.set('content-type', 'application/json')
    if (init?.token) headers.set('authorization', `Bearer ${init.token}`)
    const res = await app.request(path, { ...init, headers })
    const data = (await res.json()) as Record<string, unknown>
    return { status: res.status, data }
  }

  async function mintAndLogin(controllerKey: string): Promise<string> {
    await json('/v1/accounts/mint', {
      method: 'POST',
      body: JSON.stringify({
        controllerKey,
        displayName: 'Accept Test',
        kind: 'agent',
      }),
    })
    const ch = await json('/v1/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ controllerKey }),
    })
    assert.equal(ch.status, 200)
    const login = await json('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        controllerKey,
        challenge: ch.data.challenge,
        signature: demoSig(String(ch.data.message), controllerKey),
      }),
    })
    assert.equal(login.status, 200)
    return login.data.token as string
  }

  it('demoHint for non-EC keys documents sha256; agent card documents BSM', async () => {
    const ch = await json('/v1/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ controllerKey: 'demo-agent-key-1' }),
    })
    assert.equal(ch.status, 200)
    const hint = String(ch.data.demoHint)
    assert.match(hint, /sha256_hex/)
    assert.match(hint, /BSM-sign|compact base64/i)
    assert.doesNotMatch(hint, /^agents: signature = sha256_hex/)

    const card = await json('/.well-known/agent.json')
    assert.equal(card.status, 200)
    const auth = card.data.auth as { note?: string }
    assert.match(String(auth.note), /BSM|Bitcoin-Signed-Message/i)
    assert.match(String(auth.note), /demo sha256/i)
    const acceptance = card.data.acceptance as { kinds?: string[] }
    assert.ok(acceptance?.kinds?.includes('hash'))
    assert.ok(acceptance?.kinds?.includes('llm-judge'))
  })

  it('demoHint for compressed EC key requires BSM not demo sha256', async () => {
    const ecKey =
      '02' + 'ab'.repeat(32) // 33-byte compressed shape
    const ch = await json('/v1/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ controllerKey: ecKey }),
    })
    assert.equal(ch.status, 200)
    assert.match(String(ch.data.demoHint), /BSM-sign/)
    assert.match(String(ch.data.demoHint), /401 invalid_signature/)
  })

  it('manual submit keeps milestone submitted (not failed)', async () => {
    const poster = await mintAndLogin(`manual-poster-${Date.now()}`)
    const created = await json('/v1/bounties', {
      method: 'POST',
      token: poster,
      body: JSON.stringify({
        title: 'Manual logo',
        description: 'Approve by hand please',
        category: 'design',
        amountSats: 1000,
        acceptance: { kind: 'manual' },
        milestones: [
          { title: 'Logo', amountSats: 1000, acceptance: { kind: 'manual' } },
        ],
        useEscrow: false,
      }),
    })
    assert.equal(created.status, 201)
    const bounty = created.data.bounty as { id: string }
    const workerKey = `manual-worker-${Date.now()}`
    await mintAndLogin(workerKey)
    const claim = await json(`/v1/bounties/${bounty.id}/claim`, {
      method: 'POST',
      body: JSON.stringify({ workerPubKey: workerKey }),
    })
    assert.equal(claim.status, 200)

    const submit = await json(`/v1/bounties/${bounty.id}/submit`, {
      method: 'POST',
      body: JSON.stringify({
        workUri: 'https://example.com/logo.png',
        workHash: 'a'.repeat(64),
      }),
    })
    assert.equal(submit.status, 200)
    const out = submit.data.bounty as {
      status: string
      milestones?: Array<{ status: string }>
      lastVerification?: { passed: boolean; reason: string }
    }
    assert.equal(out.status, 'submitted')
    assert.equal(out.lastVerification?.reason, 'manual_approval_required')
    assert.equal(out.lastVerification?.passed, false)
    assert.equal(out.milestones?.[0]?.status, 'submitted')
    assert.notEqual(out.milestones?.[0]?.status, 'failed')
  })

  it('hash pass auto-releases', async () => {
    const bytes = new Uint8Array([9, 8, 7, 6])
    const digest = sha256Hex(bytes)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })) as typeof fetch

    try {
      const poster = await mintAndLogin(`hash-poster-${Date.now()}`)
      const created = await json('/v1/bounties', {
        method: 'POST',
        token: poster,
        body: JSON.stringify({
          title: 'Hash bounty',
          description: 'File hash must match',
          category: 'data',
          amountSats: 500,
          acceptance: { kind: 'hash' },
          useEscrow: false,
        }),
      })
      assert.equal(created.status, 201)
      const bounty = created.data.bounty as { id: string; acceptance?: { kind: string } }
      assert.equal(bounty.acceptance?.kind, 'hash')

      const workerKey = `hash-worker-${Date.now()}`
      await json(`/v1/bounties/${bounty.id}/claim`, {
        method: 'POST',
        body: JSON.stringify({ workerPubKey: workerKey }),
      })

      const submit = await json(`/v1/bounties/${bounty.id}/submit`, {
        method: 'POST',
        body: JSON.stringify({
          workUri: 'https://example.com/artifact.bin',
          workHash: digest,
        }),
      })
      assert.equal(submit.status, 200)
      assert.equal(submit.data.autoReleased, true)
      const out = submit.data.bounty as { status: string }
      assert.equal(out.status, 'paid')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('llm-judge mocked pass auto-releases', async () => {
    llmPass = true
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('deliverable text that is fine', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })) as typeof fetch

    try {
      const poster = await mintAndLogin(`llm-poster-${Date.now()}`)
      const created = await json('/v1/bounties', {
        method: 'POST',
        token: poster,
        body: JSON.stringify({
          title: 'LLM judge bounty',
          description: 'Judge the writeup',
          category: 'content',
          amountSats: 750,
          requirements: ['clear summary'],
          acceptance: { kind: 'llm-judge', rubric: 'Must summarize clearly' },
          useEscrow: false,
        }),
      })
      assert.equal(created.status, 201)
      const bounty = created.data.bounty as { id: string }

      await json(`/v1/bounties/${bounty.id}/claim`, {
        method: 'POST',
        body: JSON.stringify({ workerPubKey: `llm-worker-${Date.now()}` }),
      })

      const submit = await json(`/v1/bounties/${bounty.id}/submit`, {
        method: 'POST',
        body: JSON.stringify({
          workUri: 'https://example.com/writeup.txt',
          notes: 'done',
        }),
      })
      assert.equal(submit.status, 200)
      assert.equal(submit.data.autoReleased, true)
      const verification = submit.data.verification as { passed: boolean; kind: string }
      assert.equal(verification.passed, true)
      assert.equal(verification.kind, 'llm-judge')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
