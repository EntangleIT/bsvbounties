import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

describe('tinybets market hooks', () => {
  let app: ReturnType<typeof createApp>

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
      basePath: '',
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

  async function keySession(controllerKey: string): Promise<{ token: string; number: number }> {
    const minted = await json('/v1/accounts/mint', {
      method: 'POST',
      body: JSON.stringify({ controllerKey, kind: 'agent' }),
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

  async function makeMarket(makerToken: string, amountSats: number) {
    const deadline = Math.floor(Date.now() / 1000) + 3600
    const created = await json('/v1/bounties', {
      method: 'POST',
      token: makerToken,
      body: JSON.stringify({
        title: '🎲 Will BSV close above $30 Friday?',
        description: 'TinyBets test market.',
        category: 'prediction',
        amountSats,
        useEscrow: false,
        acceptance: { kind: 'manual' },
        market: {
          kind: 'tinybets',
          takerSide: 'no',
          oracle: 'https://oracle.test/resolve/mkt_demo',
          deadline,
          forfeitBondToMaker: true,
        },
      }),
    })
    assert.equal(created.status, 201)
    return (created.data.bounty as { id: string }).id
  }

  it('stores market metadata on create', async () => {
    const maker = await keySession('demo-mkt-maker')
    const id = await makeMarket(maker.token, 500)
    const got = await json(`/v1/bounties/${id}`)
    assert.equal(got.status, 200)
    assert.equal((got.data.market as { kind: string }).kind, 'tinybets')
  })

  it('rejects under-staked takers, accepts matched stakes', async () => {
    const maker = await keySession('demo-mkt-maker2')
    const poor = await keySession('demo-mkt-poor')
    const rich = await keySession('demo-mkt-rich')
    const id1 = await makeMarket(maker.token, 500)
    const id2 = await makeMarket(maker.token, 500)

    await json('/v1/bonds/deposit', {
      method: 'POST',
      token: poor.token,
      body: JSON.stringify({ controllerKey: 'demo-mkt-poor', amountSats: 100, role: 'worker' }),
    })
    const denied = await json(`/v1/bounties/${id1}/claim`, {
      method: 'POST',
      token: poor.token,
      body: JSON.stringify({ workerPubKey: 'demo-mkt-poor', workerAccount: poor.number }),
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.data.error, 'taker_bond_insufficient')

    await json('/v1/bonds/deposit', {
      method: 'POST',
      token: rich.token,
      body: JSON.stringify({ controllerKey: 'demo-mkt-rich', amountSats: 500, role: 'worker' }),
    })
    const ok = await json(`/v1/bounties/${id2}/claim`, {
      method: 'POST',
      token: rich.token,
      body: JSON.stringify({ workerPubKey: 'demo-mkt-rich', workerAccount: rich.number }),
    })
    assert.equal(ok.status, 200)
  })

  it('maker win forfeits taker bond; taker win releases it', async () => {
    const maker = await keySession('demo-mkt-maker3')
    const taker = await keySession('demo-mkt-taker3')
    await json('/v1/bonds/deposit', {
      method: 'POST',
      token: taker.token,
      body: JSON.stringify({ controllerKey: 'demo-mkt-taker3', amountSats: 400, role: 'worker' }),
    })

    const idLose = await makeMarket(maker.token, 400)
    await json(`/v1/bounties/${idLose}/claim`, {
      method: 'POST',
      token: taker.token,
      body: JSON.stringify({ workerPubKey: 'demo-mkt-taker3', workerAccount: taker.number }),
    })
    const refunded = await json(`/v1/bounties/${idLose}/settle`, {
      method: 'POST',
      token: maker.token,
      body: JSON.stringify({ outcome: 'refunded' }),
    })
    assert.equal(refunded.status, 200)
    assert.equal(
      (refunded.data.market as { forfeitedTo: string }).forfeitedTo,
      'demo-mkt-maker3',
    )
    const bond = await json('/v1/bonds/demo-mkt-taker3')
    const slashed = (bond.data.history as Array<{ status: string; forfeitedTo?: string }>).find(
      (b) => b.status === 'slashed',
    )
    assert.ok(slashed, 'taker bond slashed')
    assert.equal(slashed.forfeitedTo, 'demo-mkt-maker3')

    const idWin = await makeMarket(maker.token, 400)
    await json('/v1/bonds/deposit', {
      method: 'POST',
      token: taker.token,
      body: JSON.stringify({ controllerKey: 'demo-mkt-taker3', amountSats: 400, role: 'worker' }),
    })
    await json(`/v1/bounties/${idWin}/claim`, {
      method: 'POST',
      token: taker.token,
      body: JSON.stringify({ workerPubKey: 'demo-mkt-taker3', workerAccount: taker.number }),
    })
    const paid = await json(`/v1/bounties/${idWin}/settle`, {
      method: 'POST',
      token: maker.token,
      body: JSON.stringify({ outcome: 'paid' }),
    })
    assert.equal(paid.status, 200)
    assert.equal((paid.data.market as { released: boolean }).released, true)
  })
})
