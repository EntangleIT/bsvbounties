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

describe('POST /v1/bounties auth gate', () => {
  let app: ReturnType<typeof createApp>
  let bountyStore: BountyStore

  before(async () => {
    process.env.AUTH_MODE = 'both'
    process.env.ESCROW_MODE = 'app'
    process.env.REQUIRE_POSTER_BOND = 'false'
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
        displayName: 'Auth Test',
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
    assert.ok(typeof login.data.token === 'string')
    return login.data.token as string
  }

  it('rejects unauthenticated create with 401 and does not index', async () => {
    const before = bountyStore.count()
    const res = await json('/v1/bounties', {
      method: 'POST',
      body: JSON.stringify({
        title: 'qa-probe',
        description: 'do not persist',
        category: 'other',
        amountSats: 1,
      }),
    })
    assert.equal(res.status, 401)
    assert.equal(res.data.error, 'unauthorized')
    assert.equal(bountyStore.count(), before)
  })

  it('allows authenticated create', async () => {
    const token = await mintAndLogin(`auth-poster-${Date.now()}`)
    const before = bountyStore.count()
    const res = await json('/v1/bounties', {
      method: 'POST',
      token,
      body: JSON.stringify({
        title: 'Authed bounty',
        description: 'Should persist with session',
        category: 'dev',
        amountSats: 1000,
      }),
    })
    assert.equal(res.status, 201)
    const bounty = res.data.bounty as { id?: string; posterAccount?: number }
    assert.ok(bounty?.id)
    assert.ok(typeof bounty.posterAccount === 'number')
    assert.equal(bountyStore.count(), before + 1)
  })
})
