import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createLlmFromEnv } from '@ai-bounties/llm'
import { createApp } from './app.js'
import { AccountStore } from './store/accountStore.js'
import { BondStore } from './store/bondStore.js'
import { BountyStore } from './store/bountyStore.js'
import type { JsonPersist } from './store/persist.js'
import { ChallengeStore, SessionStore } from './store/sessionStore.js'
import type { AgentpayNotifier } from './routes/bounties.js'

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

type CapturedEvent = {
  url: string
  secret: string | null
  body: Record<string, unknown>
}

describe('agentpay settle bridge', () => {
  let app: ReturnType<typeof createApp>
  let bountyStore: BountyStore
  const events: CapturedEvent[] = []

  const notifier: AgentpayNotifier = {
    secret: 'test-secret',
    fetcher: {
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const req = input instanceof Request ? input : new Request(input, init)
        events.push({
          url: req.url,
          secret: req.headers.get('x-agentpay-internal'),
          body: (await req.json()) as Record<string, unknown>,
        })
        return new Response(JSON.stringify({ ok: true, credited: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    } as unknown as Fetcher,
  }

  before(async () => {
    process.env.AUTH_MODE = 'both'
    process.env.ESCROW_MODE = 'app'
    process.env.REQUIRE_POSTER_BOND = 'false'
    process.env.REQUIRE_WORKER_BOND = 'false'
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
    app = createApp({
      publicUrl: 'http://localhost:8787',
      webOrigins: ['http://localhost:5173'],
      network: 'test',
      llm: createLlmFromEnv(),
      stores: { bounties: bountyStore, accounts, sessions, challenges, bonds },
      agentpay: notifier,
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
      body: JSON.stringify({ controllerKey, displayName: 'Bridge Test', kind: 'agent' }),
    })
    const ch = await json('/v1/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ controllerKey }),
    })
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

  async function createClaimedBounty(
    token: string,
    tag: string,
    deadline?: number,
  ): Promise<string> {
    const created = await json('/v1/bounties', {
      method: 'POST',
      token,
      body: JSON.stringify({
        title: `bridge-${tag}`,
        description: 'Settle notification test',
        category: 'dev',
        amountSats: 40000,
        ...(deadline != null ? { deadline } : {}),
      }),
    })
    assert.equal(created.status, 201)
    const bounty = created.data.bounty as { id: string }
    assert.ok(bounty?.id)

    const claimed = await json(`/v1/bounties/${bounty.id}/claim`, {
      method: 'POST',
      body: JSON.stringify({ workerPubKey: 'agentpay:w_bridge_test' }),
    })
    assert.equal(claimed.status, 200)

    const submitted = await json(`/v1/bounties/${bounty.id}/submit`, {
      method: 'POST',
      body: JSON.stringify({ notes: 'done', workUri: 'https://example.com/work' }),
    })
    assert.equal(submitted.status, 200)
    return bounty.id
  }

  it('posts a paid event when a bounty settles', async () => {
    const token = await mintAndLogin(`bridge-poster-${Date.now()}`)
    const bountyId = await createClaimedBounty(token, 'paid')
    events.length = 0

    const settled = await json(`/v1/bounties/${bountyId}/settle`, {
      method: 'POST',
      token,
      body: JSON.stringify({ outcome: 'paid', settleTxid: 'tx_bridge_paid' }),
    })
    assert.equal(settled.status, 200)

    assert.equal(events.length, 1)
    const event = events[0]
    assert.match(event.url, /\/api\/agentpay\/internal\/bounty-event$/)
    assert.equal(event.secret, 'test-secret')
    assert.equal(event.body.bountyId, bountyId)
    assert.equal(event.body.outcome, 'paid')
    assert.equal(event.body.amountSats, 40000)
    assert.equal(event.body.settleTxid, 'tx_bridge_paid')
  })

  it('posts a refunded event when a bounty is refunded', async () => {
    const token = await mintAndLogin(`bridge-poster-refund-${Date.now()}`)
    const bountyId = await createClaimedBounty(token, 'refund', 1)
    events.length = 0

    const settled = await json(`/v1/bounties/${bountyId}/settle`, {
      method: 'POST',
      token,
      body: JSON.stringify({ outcome: 'refunded' }),
    })
    assert.equal(settled.status, 200)

    assert.equal(events.length, 1)
    assert.equal(events[0].body.bountyId, bountyId)
    assert.equal(events[0].body.outcome, 'refunded')
  })
})
