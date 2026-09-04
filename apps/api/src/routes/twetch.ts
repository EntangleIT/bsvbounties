import { Hono } from 'hono'
import { z } from 'zod'
import {
  buildLoginUrl,
  exchangeCode as defaultExchangeCode,
  fetchDiscovery,
  identityFromClaims,
  pkceChallenge,
  randomUrlSafe,
  twetchControllerKey,
  verifyIdToken as defaultVerifyIdToken,
  type Network,
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
  /**
   * Link intent: the logged-in account to attach the identity to.
   * Login intent (Login with Twetch): null — the account is resolved from
   * the verified `sub` at complete time (find-or-mint).
   */
  accountNumber: number | null
  controllerKey: string | null
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
  /** Network for accounts minted by Login with Twetch. */
  network: Network
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
  const { accounts, sessions, network } = deps
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

  /**
   * Start a Twetch flow.
   *
   * - With a Bearer session: LINK intent — attach the identity to the
   *   logged-in account (`mode: 'link'`, accountNumber echoed).
   * - Without: LOGIN intent (Login with Twetch) — the account is resolved
   *   from the verified `sub` at complete time, minting on first login
   *   (`mode: 'login'`). The visitor opens authorizationUrl, approves at
   *   the issuer, then POSTs the code to /complete (browser or agent).
   */
  app.get('/login', async (c) => {
    const cfg = getConfig()
    if (!cfg) return c.json({ error: 'twetch_not_configured' }, 501)
    const session = getSessionFromRequest(sessions, c.req.header('Authorization'))
    let accountNumber: number | null = null
    let controllerKey: string | null = null
    if (session) {
      const account = accounts.getByNumber(session.accountNumber)
      if (!account || account.controllerKey !== session.controllerKey) {
        return c.json({ error: 'stale_session' }, 401)
      }
      accountNumber = account.number
      controllerKey = session.controllerKey
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
      accountNumber,
      controllerKey,
      expires,
    })
    return c.json({
      authorizationUrl,
      state,
      expiresAt: new Date(expires).toISOString(),
      mode: accountNumber == null ? 'login' : 'link',
      ...(accountNumber == null ? {} : { accountNumber }),
    })
  })

  /**
   * Complete a flow with the authorization code (browser or agent).
   *
   * - LINK intent (pending carries an account): requires the matching
   *   session, attaches the identity, returns { account }.
   * - LOGIN intent (pending has no account): no session needed; finds the
   *   account by Twetch `sub`, minting a Twetch-native account
   *   (`controllerKey: twetch:<sub>`) on first login, opens a session and
   *   returns { token, expiresAt, account, newAccount }.
   */
  app.post('/complete', async (c) => {
    const cfg = getConfig()
    if (!cfg) return c.json({ error: 'twetch_not_configured' }, 501)
    const session = getSessionFromRequest(sessions, c.req.header('Authorization'))
    const body = z
      .object({ code: z.string().min(4), state: z.string().min(8) })
      .parse(await c.req.json())

    const attempt = await pending.take(body.state)
    if (!attempt) {
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

    if (attempt.accountNumber == null) {
      return completeLogin(c, claims)
    }

    if (
      !session ||
      attempt.accountNumber !== session.accountNumber ||
      attempt.controllerKey !== session.controllerKey
    ) {
      return c.json({ error: 'invalid_state' }, 400)
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

  /** Login with Twetch: find-or-mint by verified sub, open a session. */
  async function completeLogin(
    c: { json: (body: unknown, status?: number) => Response },
    claims: VerifiedTwetchClaims,
  ) {
    // The sub is the stable identity: whoever carries it IS the account,
    // regardless of controller key (wallet-linked, native, or unlinked).
    // This keeps the one-sub-per-account invariant the link flow enforces.
    const bySub = accounts.getByTwetchSub(claims.sub)
    if (bySub) {
      const refreshed = await accounts.update(bySub.number, {
        twetch: identityFromClaims(claims),
      })
      const session = await sessions.create(
        bySub.controllerKey,
        bySub.number,
      )
      return c.json({
        token: session.token,
        expiresAt: session.expiresAt,
        account: refreshed ?? bySub,
        newAccount: false,
      })
    }
    const controllerKey = twetchControllerKey(claims.sub)
    const owned = accounts.getByController(controllerKey)
    if (owned.length > 0) {
      const account = owned[0]!
      if (!account.twetch?.sub) {
        await accounts.update(account.number, {
          twetch: identityFromClaims(claims),
        })
      }
      const session = await sessions.create(controllerKey, account.number)
      const fresh = accounts.getByNumber(account.number)
      return c.json({
        token: session.token,
        expiresAt: session.expiresAt,
        account: fresh ?? account,
        newAccount: false,
      })
    }
    const account = await accounts.mint({
      controllerKey,
      displayName:
        claims.displayName ?? claims.handle ?? `twetch:${claims.sub}`,
      bio: '',
      kind: 'human',
      network,
    })
    const linked = await accounts.update(account.number, {
      twetch: identityFromClaims(claims),
    })
    const session = await sessions.create(controllerKey, account.number)
    return c.json({
      token: session.token,
      expiresAt: session.expiresAt,
      account: linked ?? account,
      newAccount: true,
    })
  }

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
