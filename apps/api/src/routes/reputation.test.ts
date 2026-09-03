import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { sha256Hex } from '@ai-bounties/shared'
import { createLlmFromEnv } from '@ai-bounties/llm'
import { createApp } from '../app.js'
import { AccountStore } from '../store/accountStore.js'
import { BondStore } from '../store/bondStore.js'
import { BountyStore } from '../store/bountyStore.js'
import type { JsonPersist } from '../store/persist.js'
import { ChallengeStore, SessionStore } from '../store/sessionStore.js'

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

describe('reputation leaderboard', () => {
  let app: ReturnType<typeof createApp>
  let origFetch: typeof fetch

  before(async () => {
    process.env.AUTH_MODE = 'both'
    process.env.ESCROW_MODE = 'app'
    process.env.REQUIRE_POSTER_BOND = 'false'
    process.env.REQUIRE_WORKER_BOND = 'false'
    delete process.env.VERIFIED_POST_MIN_SATS
    const stores = {
      bounties: new BountyStore(memoryPersist()),
      accounts: new AccountStore(memoryPersist()),
      sessions: new SessionStore(memoryPersist()),
      challenges: new ChallengeStore(memoryPersist()),
      bonds: new BondStore(memoryPersist()),
    }
    await Promise.all([
      stores.bounties.init(),
      stores.accounts.init(),
      stores.sessions.init(),
      stores.challenges.init(),
      stores.bonds.init(),
    ])
    app = createApp({
      publicUrl: 'http://localhost:8787',
      webOrigins: ['http://localhost:5173'],
      network: 'test',
      llm: createLlmFromEnv(),
      stores,
    })
  })

  after(() => {
    if (origFetch) globalThis.fetch = origFetch
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

  async function keySession(
    controllerKey: string,
    kind: 'human' | 'agent' = 'agent',
  ): Promise<{ token: string; number: number }> {
    const minted = await json('/v1/accounts/mint', {
      method: 'POST',
      body: JSON.stringify({ controllerKey, kind }),
    })
    assert.equal(minted.status, 201)
    const number = (minted.data.account as { number: number }).number
    const ch = await json('/v1/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ controllerKey }),
    })
    const login = await json('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        controllerKey,
        challenge: ch.data.challenge,
        signature: demoSig(ch.data.message as string, controllerKey),
        accountNumber: number,
      }),
    })
    assert.equal(login.status, 200)
    return { token: login.data.token as string, number }
  }

  it('ranks proven workers above newcomers with full reputation payloads', async () => {
    const bytes = new Uint8Array([9, 8, 7, 6])
    const digest = sha256Hex(bytes)
    origFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })) as typeof fetch

    try {
      const poster = await keySession('demo-rep-poster', 'human')
      const pro = await keySession('demo-rep-pro', 'agent')
      await keySession('demo-rep-new', 'agent')

      const created = await json('/v1/bounties', {
        method: 'POST',
        token: poster.token,
        body: JSON.stringify({
          title: 'Rep bounty',
          description: 'hash must match',
          category: 'data',
          amountSats: 500,
          acceptance: { kind: 'hash' },
          useEscrow: false,
        }),
      })
      assert.equal(created.status, 201)
      const id = (created.data.bounty as { id: string }).id
      await json(`/v1/bounties/${id}/claim`, {
        method: 'POST',
        body: JSON.stringify({
          workerPubKey: 'demo-rep-pro',
          workerAccount: pro.number,
        }),
      })
      const submit = await json(`/v1/bounties/${id}/submit`, {
        method: 'POST',
        token: pro.token,
        body: JSON.stringify({
          workUri: 'https://example.com/artifact.bin',
          workHash: digest,
        }),
      })
      assert.equal(
        (submit.data.verification as { passed: boolean }).passed,
        true,
      )

      const board = await json('/v1/accounts/leaderboard?kind=agent')
      assert.equal(board.status, 200)
      const items = board.data.items as Array<{
        number: number
        reputation: {
          score: number
          tier: string
          provisional: boolean
          contributions: Record<string, number>
        }
      }>
      assert.ok(items.length >= 2)
      // Proven worker first, newcomer after.
      assert.equal(items[0]!.number, pro.number)
      assert.ok(items[0]!.reputation.score > 500)
      assert.equal(items[0]!.reputation.provisional, false)
      assert.ok('quality' in items[0]!.reputation.contributions)
      const newcomer = items.find((i) => i.reputation.provisional)
      assert.ok(newcomer)
      assert.equal(newcomer.reputation.score, 500)
      assert.ok(board.data.scoredAt)

      const limited = await json('/v1/accounts/leaderboard?limit=1')
      assert.equal(
        (limited.data.items as unknown[]).length,
        1,
      )
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
