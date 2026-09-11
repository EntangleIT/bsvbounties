import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
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

const INTERNAL_SECRET = 'test-internal-secret'

describe('agentpay-funded bounty internals', () => {
  let app: ReturnType<typeof createApp>
  let bountyStore: BountyStore
  const events: Array<Record<string, unknown>> = []

  const notifier: AgentpayNotifier = {
    secret: INTERNAL_SECRET,
    fetcher: {
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const req = input instanceof Request ? input : new Request(input, init)
        events.push((await req.json()) as Record<string, unknown>)
        return new Response(JSON.stringify({ ok: true }), {
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
    process.env.AGENTPAY_WEBHOOK_SECRET = INTERNAL_SECRET
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

  async function post(path: string, body: unknown, secret = INTERNAL_SECRET) {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agentpay-internal': secret },
      body: JSON.stringify(body),
    })
    return { status: res.status, data: (await res.json()) as Record<string, unknown> }
  }

  it('rejects requests without the shared secret', async () => {
    const res = await post('/v1/internal/agentpay/bounties', {}, 'wrong')
    assert.equal(res.status, 401)
  })

  it('creates an agentpay-funded bounty with on-chain escrow metadata', async () => {
    const res = await post('/v1/internal/agentpay/bounties', {
      title: 'Funded task',
      description: 'Escrowed on chain',
      category: 'dev',
      amountSats: 40000,
      escrowTxid: 'a'.repeat(64),
      posterRef: 'agentpay:apw_test',
      feeBps: 200,
    })
    assert.equal(res.status, 201)
    const bounty = res.data.bounty as Record<string, unknown>
    assert.ok(bounty.id)
    const funding = bounty.funding as Record<string, unknown>
    assert.equal(funding.method, 'agentpay')
    assert.equal(funding.status, 'funded')
    const escrow = bounty.escrow as Record<string, unknown>
    assert.equal(escrow.posterPubKey, 'agentpay:apw_test')
    assert.equal(escrow.outpoint, `${'a'.repeat(64)}:0`)
    assert.equal(bounty.status, 'open')

    // settle paid → event carries the funding rail so agentpay pays on-chain
    events.length = 0
    const settled = await post(`/v1/internal/agentpay/bounties/${bounty.id}/settle`, {
      outcome: 'paid',
    })
    assert.equal(settled.status, 200)
    assert.equal(events.length, 1)
    assert.equal(events[0].funding, 'agentpay')
    assert.equal(events[0].posterRef, 'agentpay:apw_test')
    assert.equal(events[0].outcome, 'paid')

    // txid writeback after the on-chain payout
    const txidRes = await app.request(`/v1/internal/agentpay/bounties/${bounty.id}/txid`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-agentpay-internal': INTERNAL_SECRET },
      body: JSON.stringify({ txid: 'b'.repeat(64) }),
    })
    assert.equal(txidRes.status, 200)
    const stored = bountyStore.get(String(bounty.id))
    assert.equal(stored?.settleTxid, 'b'.repeat(64))
  })

  it('refunds through the internal rail and rejects double settle', async () => {
    const created = await post('/v1/internal/agentpay/bounties', {
      title: 'Refund task',
      description: 'Refund path',
      amountSats: 50000,
      escrowTxid: 'c'.repeat(64),
      posterRef: 'agentpay:apw_refund',
    })
    const bounty = created.data.bounty as Record<string, unknown>

    const first = await post(`/v1/internal/agentpay/bounties/${bounty.id}/settle`, {
      outcome: 'refunded',
    })
    assert.equal(first.status, 200)
    assert.equal(events.at(-1)?.outcome, 'refunded')

    const second = await post(`/v1/internal/agentpay/bounties/${bounty.id}/settle`, {
      outcome: 'paid',
    })
    assert.equal(second.status, 409)
  })
})
