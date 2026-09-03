import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  createSubmitSeal,
  type SealEnvelope,
} from '@ai-bounties/shared'
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

const WORK = 'ef'.repeat(32)

describe('sealed submissions', () => {
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

  async function keySession(controllerKey: string): Promise<string> {
    const minted = await json('/v1/accounts/mint', {
      method: 'POST',
      body: JSON.stringify({ controllerKey, kind: 'human' }),
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
    return login.data.token as string
  }

  async function sealedBounty(
    token: string,
    acceptance: Record<string, unknown> = { kind: 'sealed' },
  ): Promise<string> {
    const created = await json('/v1/bounties', {
      method: 'POST',
      token,
      body: JSON.stringify({
        title: 'Sealed work',
        description: 'prove it without showing it',
        category: 'dev',
        amountSats: 1000,
        acceptance,
      }),
    })
    assert.equal(created.status, 201)
    return (created.data.bounty as { id: string }).id
  }

  async function claim(id: string, workerKey: string) {
    const res = await json(`/v1/bounties/${id}/claim`, {
      method: 'POST',
      body: JSON.stringify({ workerPubKey: workerKey }),
    })
    assert.equal(res.status, 200)
  }

  async function submit(
    id: string,
    body: Record<string, unknown>,
    token?: string,
  ) {
    return json(`/v1/bounties/${id}/submit`, {
      method: 'POST',
      token,
      body: JSON.stringify({ workHash: WORK, ...body }),
    })
  }

  it('fails closed without an envelope', async () => {
    const poster = await keySession('demo-seal-poster-1')
    const id = await sealedBounty(poster)
    await claim(id, 'demo-seal-worker-1')
    const res = await submit(id, {})
    assert.equal(res.status, 200)
    const out = res.data as {
      bounty: { status: string; seal?: unknown }
      verification: { passed: boolean; reason: string }
    }
    assert.equal(out.verification.passed, false)
    assert.equal(out.verification.reason, 'seal_missing')
    assert.equal(out.bounty.status, 'submitted')
  })

  it('passes a valid envelope and persists it', async () => {
    const poster = await keySession('demo-seal-poster-2')
    const workerToken = await keySession('demo-seal-worker-2')
    const id = await sealedBounty(poster)
    await claim(id, 'demo-seal-worker-2')
    const seal = createSubmitSeal({
      workHash: WORK,
      submitter: { controllerKey: 'demo-seal-worker-2' },
    })
    const res = await submit(id, { seal }, workerToken)
    const out = res.data as {
      bounty: { status: string; seal?: SealEnvelope }
      verification: { passed: boolean; reason: string }
    }
    assert.equal(out.verification.passed, true)
    assert.equal(out.verification.reason, 'sealed_chain_valid')
    assert.equal(out.bounty.seal?.workHash, WORK.toLowerCase())
    assert.ok((out.bounty.seal?.events?.length ?? 0) >= 1)
  })

  it('rejects tampered envelopes (hard fail, stays submitted)', async () => {
    const poster = await keySession('demo-seal-poster-3')
    await keySession('demo-seal-worker-3')
    const id = await sealedBounty(poster)
    await claim(id, 'demo-seal-worker-3')
    const seal = createSubmitSeal({
      workHash: WORK,
      submitter: { controllerKey: 'demo-seal-worker-3' },
    })
    seal.events[0]!.actorName = 'mallory'
    const res = await submit(id, { seal })
    const out = res.data as {
      bounty: { status: string }
      verification: { passed: boolean; reason: string }
    }
    assert.equal(out.verification.passed, false)
    assert.equal(out.verification.reason, 'seal_event_hash_mismatch')
    assert.equal(out.bounty.status, 'submitted')
  })

  it('binds the envelope to the authenticated submitter', async () => {
    const poster = await keySession('demo-seal-poster-4')
    const workerToken = await keySession('demo-seal-worker-4')
    const id = await sealedBounty(poster)
    await claim(id, 'demo-seal-worker-4')
    const seal = createSubmitSeal({
      workHash: WORK,
      submitter: { controllerKey: 'demo-seal-impostor' },
    })
    const res = await submit(id, { seal }, workerToken)
    const out = res.data as {
      verification: { passed: boolean; reason: string }
    }
    assert.equal(out.verification.passed, false)
    assert.equal(out.verification.reason, 'seal_actor_mismatch')
  })
})
