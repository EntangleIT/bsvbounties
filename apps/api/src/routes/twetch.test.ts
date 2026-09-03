import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createLlmFromEnv } from '@ai-bounties/llm'
import { createApp } from '../app.js'
import { AccountStore } from '../store/accountStore.js'
import { BondStore } from '../store/bondStore.js'
import { BountyStore } from '../store/bountyStore.js'
import type { JsonPersist } from '../store/persist.js'
import { ChallengeStore, SessionStore } from '../store/sessionStore.js'
import { PendingTwetchStore } from './twetch.js'

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

const ISSUER = 'https://id.example.com'
const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/auth`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
}

describe('Twetch verified accounts', () => {
  let app: ReturnType<typeof createApp>
  let origFetch: typeof fetch
  let capturedExchange: Record<string, unknown> | null = null

  before(async () => {
    delete process.env.TWETCH_ISSUER
    delete process.env.TWETCH_CLIENT_ID
    process.env.AUTH_MODE = 'both'
    process.env.ESCROW_MODE = 'app'
    process.env.REQUIRE_POSTER_BOND = 'false'
    process.env.REQUIRE_WORKER_BOND = 'false'
    delete process.env.VERIFIED_POST_MIN_SATS

    origFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).endsWith('/.well-known/openid-configuration')) {
        return new Response(JSON.stringify(DISCOVERY), { status: 200 })
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    }) as typeof fetch

    const accounts = new AccountStore(memoryPersist())
    const sessions = new SessionStore(memoryPersist())
    const challenges = new ChallengeStore(memoryPersist())
    const bonds = new BondStore(memoryPersist())
    const bounties = new BountyStore(memoryPersist())
    const pending = new PendingTwetchStore(memoryPersist())
    await Promise.all([
      accounts.init(),
      sessions.init(),
      challenges.init(),
      bonds.init(),
      bounties.init(),
      pending.init(),
    ])
    app = createApp({
      publicUrl: 'http://localhost:8787',
      webOrigins: ['http://localhost:5173'],
      network: 'test',
      llm: createLlmFromEnv(),
      stores: {
        bounties,
        accounts,
        sessions,
        challenges,
        bonds,
      },
      twetch: {
        config: {
          issuer: ISSUER,
          clientId: 'bounties-test',
          redirectUri: 'http://localhost:5173/twetch-callback',
          clientSecret: 'test-secret-xyz',
        },
        pending,
        // Stub OIDC: idToken carries the code; sub derives from it so each
        // test can choose a fresh identity or force a collision with dup-*.
        exchangeCode: (async (opts: { code: string }) => {
          capturedExchange = opts as Record<string, unknown>
          return { idToken: `stub:${opts.code}` }
        }) as never,
        verifyIdToken: (async (opts: { idToken: string }) => {
          const code = opts.idToken.replace(/^stub:/, '')
          const sub = code.startsWith('dup') ? 'twetch-7' : `twetch-${code}`
          return { sub, handle: `user-${code}`, displayName: `User ${code}` }
        }) as never,
      },
    })
  })

  after(() => {
    globalThis.fetch = origFetch
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

  async function loginAs(
    controllerKey: string,
    accountNumber?: number,
  ): Promise<string> {
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
        signature: demoSig(ch.data.message as string, controllerKey),
        accountNumber,
      }),
    })
    assert.equal(login.status, 200)
    return login.data.token as string
  }

  async function mintAndLogin(
    controllerKey: string,
  ): Promise<{ token: string; number: number }> {
    const minted = await json('/v1/accounts/mint', {
      method: 'POST',
      body: JSON.stringify({
        controllerKey,
        displayName: 'Twetch Test',
        kind: 'human',
      }),
    })
    assert.equal(minted.status, 201)
    const number = (minted.data.account as { number: number }).number
    const token = await loginAs(controllerKey, number)
    return { token, number }
  }

  async function linkFlow(
    token: string,
    code: string,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const login = await json('/v1/auth/twetch/login', { token })
    assert.equal(login.status, 200)
    assert.ok(
      (login.data.authorizationUrl as string).startsWith(`${ISSUER}/auth?`),
    )
    return json('/v1/auth/twetch/complete', {
      method: 'POST',
      token,
      body: JSON.stringify({ code, state: login.data.state }),
    })
  }

  it('links a Twetch identity to an account', async () => {
    const { token, number } = await mintAndLogin('demo-twetch-a')
    const done = await linkFlow(token, 'auth-code-1')
    assert.equal(done.status, 200)
    const linked = done.data.account as {
      number: number
      twetch: { sub: string; handle: string }
    }
    assert.equal(linked.number, number)
    assert.equal(linked.twetch.sub, 'twetch-auth-code-1')
    assert.equal(linked.twetch.handle, 'user-auth-code-1')
    // Confidential client: secret is forwarded to the token endpoint.
    assert.equal(capturedExchange?.clientSecret, 'test-secret-xyz')

    const status = await json('/v1/auth/twetch/status', { token })
    assert.equal(status.status, 200)
    assert.equal(status.data.verified, true)
  })

  it('rejects reuse of the same Twetch sub on another account', async () => {
    const a = await mintAndLogin('demo-twetch-b')
    const first = await linkFlow(a.token, 'dup-1')
    assert.equal(first.status, 200)

    const b = await mintAndLogin('demo-twetch-c')
    const second = await linkFlow(b.token, 'dup-2')
    assert.equal(second.status, 409)
    assert.equal(second.data.error, 'already_linked')
    assert.equal(second.data.accountNumber, a.number)
  })

  it('rejects unknown states and enforces sessions', async () => {
    const anon = await json('/v1/auth/twetch/complete', {
      method: 'POST',
      body: JSON.stringify({ code: 'code-x', state: 'nope-not-real' }),
    })
    assert.equal(anon.status, 401)

    const { token } = await mintAndLogin('demo-twetch-d')
    const wrong = await json('/v1/auth/twetch/complete', {
      method: 'POST',
      token,
      body: JSON.stringify({ code: 'code-x', state: 'consumed-or-unknown' }),
    })
    assert.equal(wrong.status, 400)
    assert.equal(wrong.data.error, 'invalid_state')

    const anonLogin = await json('/v1/auth/twetch/login')
    assert.equal(anonLogin.status, 401)
  })

  it('unlinks identity and frees the sub', async () => {
    const { token } = await mintAndLogin('demo-twetch-e')
    const done = await linkFlow(token, 'unlink-1')
    assert.equal(done.status, 200)

    const unlink = await json('/v1/auth/twetch/unlink', {
      method: 'POST',
      token,
    })
    assert.equal(unlink.status, 200)
    assert.equal(
      (unlink.data.account as Record<string, unknown>).twetch,
      undefined,
    )

    const status = await json('/v1/auth/twetch/status', { token })
    assert.equal(status.data.verified, false)

    // Sub is free again: a different account can claim it.
    const other = await mintAndLogin('demo-twetch-f')
    const relink = await linkFlow(other.token, 'unlink-1')
    assert.equal(relink.status, 200)
  })

  it('transfer clears the Twetch link', async () => {
    const seller = await mintAndLogin('demo-twetch-g')
    const done = await linkFlow(seller.token, 'xfer-1')
    assert.equal(done.status, 200)

    const tx = await json(`/v1/accounts/${seller.number}/transfer`, {
      method: 'POST',
      token: seller.token,
      body: JSON.stringify({ toControllerKey: 'demo-twetch-buyer' }),
    })
    assert.equal(tx.status, 200)
    assert.equal(
      (tx.data.account as Record<string, unknown>).twetch,
      undefined,
    )
  })

  it('gates high-value posts when VERIFIED_POST_MIN_SATS is set', async () => {
    process.env.VERIFIED_POST_MIN_SATS = '1000'
    try {
      const { token } = await mintAndLogin('demo-twetch-h')
      const big = await json('/v1/bounties', {
        method: 'POST',
        token,
        body: JSON.stringify({
          title: 'Expensive job',
          description: 'needs verification',
          category: 'dev',
          amountSats: 5000,
        }),
      })
      assert.equal(big.status, 403)
      assert.equal(big.data.error, 'needs_verification')

      const small = await json('/v1/bounties', {
        method: 'POST',
        token,
        body: JSON.stringify({
          title: 'Cheap job',
          description: 'no verification needed',
          category: 'dev',
          amountSats: 500,
        }),
      })
      assert.equal(small.status, 201)

      // Verified posters pass the gate.
      const verified = await mintAndLogin('demo-twetch-i')
      const linked = await linkFlow(verified.token, 'gate-1')
      assert.equal(linked.status, 200)
      const bigOk = await json('/v1/bounties', {
        method: 'POST',
        token: verified.token,
        body: JSON.stringify({
          title: 'Expensive verified job',
          description: 'verified poster',
          category: 'dev',
          amountSats: 5000,
        }),
      })
      assert.equal(bigOk.status, 201)
    } finally {
      delete process.env.VERIFIED_POST_MIN_SATS
    }
  })

  it('returns 501 when Twetch is not configured', async () => {
    const accounts = new AccountStore(memoryPersist())
    const sessions = new SessionStore(memoryPersist())
    const challenges = new ChallengeStore(memoryPersist())
    const bonds = new BondStore(memoryPersist())
    const bounties = new BountyStore(memoryPersist())
    await Promise.all([
      accounts.init(),
      sessions.init(),
      challenges.init(),
      bonds.init(),
      bounties.init(),
    ])
    const bare = createApp({
      publicUrl: 'http://localhost:8787',
      webOrigins: ['http://localhost:5173'],
      network: 'test',
      llm: createLlmFromEnv(),
      stores: { bounties, accounts, sessions, challenges, bonds },
      twetch: { config: null },
    })
    // Config is checked before auth, so even anonymous callers get 501.
    const res = await bare.request('/v1/auth/twetch/login')
    assert.equal(res.status, 501)
    const health = (await (await bare.request('/health')).json()) as Record<
      string,
      unknown
    >
    assert.equal(health.twetchConfigured, false)
  })
})
