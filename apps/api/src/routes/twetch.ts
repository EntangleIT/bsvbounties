import { Hono } from 'hono'
import { z } from 'zod'
import {
  buildLoginUrl,
  exchangeCode as defaultExchangeCode,
  fetchDiscovery,
  identityFromClaims,
  pkceChallenge,
  randomUrlSafe,
  verifyIdToken as defaultVerifyIdToken,
  type TwetchRpConfig,
  type VerifiedTwetchClaims,
} from '@ai-bounties/shared'
import type { AccountStore } from '../store/accountStore.js'
import { getSessionFromRequest } from './auth.js'
import type { SessionStore } from '../store/sessionStore.js'
import { persistFrom, type JsonPersist } from '../store/persist.js'

export type { TwetchRpConfig } from '@ai-bounties/shared'

/** RP config comes from env. Secret via server env / `wrangler secret put` only. */
export function twetchConfigFromEnv(): TwetchRpConfig | null {
  const issuer = process.env.TWETCH_ISSUER?.trim()
  const clientId = process.env.TWETCH_CLIENT_ID?.trim()
  if (!issuer || !clientId) return null
  const redirectUri =
    process.env.TWETCH_REDIRECT_URI?.trim() ||
    `${(process.env.WEB_ORIGIN ?? 'http://localhost:5173').replace(/\/$/, '')}/twetch-callback`
  const clientSecret = process.env.TWETCH_CLIENT_SECRET?.trim() || undefined
  return { issuer, clientId, redirectUri, clientSecret }
}

interface PendingLogin {
  state: string
  codeVerifier: string
  accountNumber: number
  controllerKey: string
  expires: number
}

const PENDING_TTL_MS = 10 * 60 * 1000

/** Short-lived OIDC login attempts. Persisted so Cloudflare isolates share them. */
export class PendingTwetchStore {
  private backend: JsonPersist
  private map = new Map<string, PendingLogin>()

  constructor(dataDirOrPersist?: string | JsonPersist) {
    this.backend = persistFrom(
      dataDirOrPersist ?? './data',
      'twetch-pending.json',
    )
  }

  async init(): Promise<void> {
    const raw = await this.backend.read().catch(() => null)
    this.map.clear()
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as { items?: PendingLogin[] }
      const now = Date.now()
      for (const row of parsed.items ?? []) {
        if (row.expires > now) this.map.set(row.state, row)
      }
    } catch {
      /* empty */
    }
  }

  private async persist(): Promise<void> {
    await this.backend
      .write(JSON.stringify({ items: [...this.map.values()] }))
      .catch(() => undefined)
  }

  async save(row: PendingLogin): Promise<void> {
    const now = Date.now()
    for (const [k, v] of this.map) {
      if (v.expires <= now) this.map.delete(k)
    }
    this.map.set(row.state, row)
    await this.persist()
  }

  async take(state: string): Promise<PendingLogin | null> {
    const row = this.map.get(state) ?? null
    if (row) {
      this.map.delete(state)
      await this.persist()
    }
    if (!row || row.expires <= Date.now()) return null
    return row
  }
}

export type TwetchExchangeFn = typeof defaultExchangeCode
export type TwetchVerifyFn = typeof defaultVerifyIdToken

export interface TwetchRouteDeps {
  accounts: AccountStore
  sessions: SessionStore
  /** Defaults to twetchConfigFromEnv(). Null disables the endpoints (501). */
  config?: TwetchRpConfig | null
  pending?: PendingTwetchStore
  exchangeCode?: TwetchExchangeFn
  verifyIdToken?: TwetchVerifyFn
}

function oidcError(e: unknown): { error: string; note: string } {
  const msg = e instanceof Error ? e.message : String(e)
  const code = msg.split(':')[0] || 'twetch_failed'
  return {
    error: code,
    note: `Twetch OIDC step failed (${code}). Retry login or check TWETCH_* config.`,
  }
}

export function twetchRoutes(deps: TwetchRouteDeps) {
  const { accounts, sessions } = deps
  const app = new Hono()
  const pending = deps.pending ?? new PendingTwetchStore()
  const doExchange = deps.exchangeCode ?? defaultExchangeCode
  const doVerify = deps.verifyIdToken ?? defaultVerifyIdToken
  let configProvided = deps.config !== undefined
  let config: TwetchRpConfig | null = deps.config ?? null
  const getConfig = (): TwetchRpConfig | null => {
    if (!configProvided) {
      config = twetchConfigFromEnv()
      configProvided = true
    }
    return config
  }

  /** Start a link flow. Logged-in account visits authorizationUrl, then POSTs code. */
  app.get('/login', async (c) => {
    const cfg = getConfig()
    if (!cfg) return c.json({ error: 'twetch_not_configured' }, 501)
    const session = getSessionFromRequest(sessions, c.req.header('Authorization'))
    if (!session) return c.json({ error: 'unauthorized' }, 401)
    const account = accounts.getByNumber(session.accountNumber)
    if (!account || account.controllerKey !== session.controllerKey) {
      return c.json({ error: 'stale_session' }, 401)
    }
    const state = randomUrlSafe(24)
    const codeVerifier = randomUrlSafe(48)
    const codeChallenge = await pkceChallenge(codeVerifier)
    let authorizationUrl: string
    try {
      ;({ authorizationUrl } = await buildLoginUrl(cfg, {
        state,
        codeChallenge,
      }))
    } catch (e) {
      return c.json(oidcError(e), 502)
    }
    const expires = Date.now() + PENDING_TTL_MS
    await pending.save({
      state,
      codeVerifier,
      accountNumber: account.number,
      controllerKey: session.controllerKey,
      expires,
    })
    return c.json({
      authorizationUrl,
      state,
      expiresAt: new Date(expires).toISOString(),
      accountNumber: account.number,
    })
  })

  /** Complete a link flow with the authorization code (browser or agent). */
  app.post('/complete', async (c) => {
    const cfg = getConfig()
    if (!cfg) return c.json({ error: 'twetch_not_configured' }, 501)
    const session = getSessionFromRequest(sessions, c.req.header('Authorization'))
    if (!session) return c.json({ error: 'unauthorized' }, 401)
    const body = z
      .object({ code: z.string().min(4), state: z.string().min(8) })
      .parse(await c.req.json())

    const attempt = await pending.take(body.state)
    if (
      !attempt ||
      attempt.accountNumber !== session.accountNumber ||
      attempt.controllerKey !== session.controllerKey
    ) {
      return c.json({ error: 'invalid_state' }, 400)
    }

    let discovery
    try {
      discovery = await fetchDiscovery(cfg.issuer)
    } catch (e) {
      return c.json(oidcError(e), 502)
    }
    let idToken: string
    try {
      ;({ idToken } = await doExchange({
        tokenEndpoint: discovery.token_endpoint,
        code: body.code,
        codeVerifier: attempt.codeVerifier,
        redirectUri: cfg.redirectUri,
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
      }))
    } catch (e) {
      return c.json(oidcError(e), 502)
    }
    let claims: VerifiedTwetchClaims
    try {
      claims = await doVerify({
        idToken,
        issuer: cfg.issuer,
        clientId: cfg.clientId,
        jwksUri: discovery.jwks_uri,
      })
    } catch (e) {
      return c.json(oidcError(e), 502)
    }

    const existing = accounts.getByTwetchSub(claims.sub)
    if (existing && existing.number !== attempt.accountNumber) {
      return c.json(
        {
          error: 'already_linked',
          accountNumber: existing.number,
          note: `Twetch identity already verifies account #${existing.number}. Unlink it first.`,
        },
        409,
      )
    }

    const updated = await accounts.update(attempt.accountNumber, {
      twetch: identityFromClaims(claims),
    })
    if (!updated) return c.json({ error: 'not_found' }, 404)
    return c.json({ account: updated })
  })

  /** Remove the Twetch link from your account. */
  app.post('/unlink', async (c) => {
    const session = getSessionFromRequest(sessions, c.req.header('Authorization'))
    if (!session) return c.json({ error: 'unauthorized' }, 401)
    const account = accounts.getByNumber(session.accountNumber)
    if (!account || account.controllerKey !== session.controllerKey) {
      return c.json({ error: 'stale_session' }, 401)
    }
    const updated = await accounts.update(account.number, { twetch: undefined })
    return c.json({ account: updated })
  })

  /** Verification state for your session account. */
  app.get('/status', (c) => {
    const session = getSessionFromRequest(sessions, c.req.header('Authorization'))
    if (!session) return c.json({ error: 'unauthorized' }, 401)
    const account = accounts.getByNumber(session.accountNumber)
    if (!account) return c.json({ error: 'not_found' }, 404)
    return c.json({
      verified: typeof account.twetch?.sub === 'string',
      twetch: account.twetch ?? null,
      configured: getConfig() != null,
    })
  })

  return app
}
