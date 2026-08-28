import { Hono } from 'hono'
import { z } from 'zod'
import {
  authMessage,
  isCompressedPubKeyHex,
  verifyBsmSignature,
} from '@ai-bounties/shared'
import type { AccountStore } from '../store/accountStore.js'
import type { SessionStore } from '../store/sessionStore.js'
import {
  ChallengeStore,
  verifyDemoSignature,
  type Session,
} from '../store/sessionStore.js'

type Env = {
  Variables: {
    session?: Session
  }
}

function bearer(c: { req: { header: (n: string) => string | undefined } }): string | null {
  const h = c.req.header('Authorization')
  if (!h?.startsWith('Bearer ')) return null
  return h.slice(7).trim()
}

function authMode(): 'demo' | 'wallet' | 'both' {
  const m = (process.env.AUTH_MODE ?? 'both').toLowerCase()
  if (m === 'wallet' || m === 'bsm') return 'wallet'
  if (m === 'demo') return 'demo'
  return 'both'
}

function signatureValid(message: string, controllerKey: string, signature: string): boolean {
  const mode = authMode()
  const realKey = isCompressedPubKeyHex(controllerKey)
  const bsmOk = realKey && verifyBsmSignature(message, controllerKey, signature)
  const demoOk = verifyDemoSignature(message, controllerKey, signature)

  // Real EC keys must BSM-sign so a stolen identity hex cannot be demo-forged.
  if (realKey) {
    if (mode === 'demo') return demoOk
    return Boolean(bsmOk)
  }
  if (mode === 'wallet') return false
  return demoOk
}

export function authRoutes(
  accounts: AccountStore,
  sessions: SessionStore,
  challenges: ChallengeStore,
) {
  const app = new Hono<Env>()

  app.use('*', async (c, next) => {
    const token = bearer(c)
    if (token) {
      const session = sessions.get(token)
      if (session) c.set('session', session)
    }
    await next()
  })

  app.post('/challenge', async (c) => {
    const body = z
      .object({ controllerKey: z.string().min(4) })
      .parse(await c.req.json())
    const issued = await challenges.issue(body.controllerKey)
    return c.json({
      challenge: issued.challenge,
      message: authMessage(issued.challenge),
      expiresAt: issued.expiresAt,
      authMode: authMode(),
      /** Demo (agent) helper. Real Yours keys must BSM-sign `message`. */
      demoHint: 'agents: signature = sha256_hex(`${message}:${controllerKey}`)',
    })
  })

  app.post('/login', async (c) => {
    const body = z
      .object({
        controllerKey: z.string().min(4),
        challenge: z.string().min(8),
        signature: z.string().min(8),
        accountNumber: z.number().int().positive().optional(),
      })
      .parse(await c.req.json())

    if (!(await challenges.consume(body.controllerKey, body.challenge))) {
      return c.json({ error: 'invalid_challenge' }, 401)
    }

    const message = authMessage(body.challenge)
    if (!signatureValid(message, body.controllerKey, body.signature)) {
      return c.json({ error: 'invalid_signature' }, 401)
    }

    const owned = accounts.getByController(body.controllerKey)
    if (owned.length === 0) {
      return c.json(
        {
          error: 'no_account',
          note: 'Mint an account first via POST /v1/accounts/mint',
        },
        404,
      )
    }

    let account = owned[0]!
    if (body.accountNumber != null) {
      const pick = owned.find((a) => a.number === body.accountNumber)
      if (!pick) return c.json({ error: 'account_not_owned' }, 403)
      account = pick
    }

    const session = await sessions.create(body.controllerKey, account.number)
    return c.json({
      token: session.token,
      expiresAt: session.expiresAt,
      account,
    })
  })

  app.get('/me', (c) => {
    const session = c.get('session')
    if (!session) return c.json({ error: 'unauthorized' }, 401)
    const account = accounts.getByNumber(session.accountNumber)
    if (!account) return c.json({ error: 'not_found' }, 404)
    return c.json({
      session: {
        accountNumber: session.accountNumber,
        expiresAt: session.expiresAt,
        controllerKey: session.controllerKey,
      },
      account,
    })
  })

  app.post('/logout', async (c) => {
    const token = bearer(c)
    if (token) await sessions.revoke(token)
    return c.json({ ok: true })
  })

  return app
}

export function getSessionFromRequest(
  sessions: SessionStore,
  authHeader: string | undefined,
): Session | undefined {
  if (!authHeader?.startsWith('Bearer ')) return undefined
  return sessions.get(authHeader.slice(7).trim())
}
