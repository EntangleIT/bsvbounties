import { Hono } from 'hono'
import { z } from 'zod'
import {
  BRC100_LABELS,
  buildMintAccountActionOutputs,
  reputationOf,
  sha256Hex,
  type AccountKind,
  type Network,
} from '@ai-bounties/shared'
import { buildAtomicAccountSwapTemplate } from '@ai-bounties/contracts'
import type { AccountStore } from '../store/accountStore.js'
import type { SessionStore } from '../store/sessionStore.js'
import type { Session } from '../store/sessionStore.js'

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

export function accountRoutes(
  accounts: AccountStore,
  sessions: SessionStore,
  defaultNetwork: Network,
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

  app.get('/', (c) => {
    const forSale = c.req.query('forSale') === 'true'
    const kind = c.req.query('kind') as AccountKind | undefined
    const controllerKey = c.req.query('controllerKey') ?? undefined
    const limit = Number(c.req.query('limit') ?? 100)
    const offset = Number(c.req.query('offset') ?? 0)
    const items = accounts.list({ forSale, kind, controllerKey, limit, offset })
    return c.json({
      items: items.map((a) => ({ ...a, reputation: reputationOf(a) })),
      total: forSale ? accounts.listForSaleCount() : accounts.count(),
    })
  })

  app.get('/marketplace', (c) => {
    const items = accounts.list({ forSale: true, limit: 100 })
    return c.json({ items, total: items.length })
  })

  /**
   * Deterministic leaderboard (Trust C): accounts ranked by reputation
   * score. No LLM involved — this is the cheap ground truth that
   * POST /v1/llm/rank-workers refines with skills matching.
   */
  app.get('/leaderboard', async (c) => {
    const kind = c.req.query('kind') as AccountKind | undefined
    const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)
    const { rows, source } = await accounts.leaderboardRows(1000).catch(() => ({
      rows: accounts.list({ kind, limit: 1000 }),
      source: 'kv' as const,
    }))
    const items = rows
      .filter((a) => (kind ? a.kind === kind : true))
      .map((a) => ({ ...a, reputation: reputationOf(a) }))
      .sort(
        (x, y) =>
          y.reputation.score - x.reputation.score || x.number - y.number,
      )
      .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 20)
    return c.json({
      items,
      total: items.length,
      scoredAt: new Date().toISOString(),
      source,
    })
  })

  /**
   * Mint next sequential account (or preferred free number).
   */
  app.post('/mint', async (c) => {
    const body = z
      .object({
        controllerKey: z.string().min(4),
        displayName: z.string().max(64).optional(),
        bio: z.string().max(500).optional(),
        kind: z.enum(['human', 'agent']).default('human'),
        preferredNumber: z.number().int().positive().optional(),
        mintTxid: z.string().optional(),
        ownerLockingScriptHex: z.string().optional(),
        network: z.enum(['main', 'test']).optional(),
        skills: z.array(z.string().min(1).max(40)).max(24).optional(),
        capabilities: z.array(z.string().min(1).max(40)).max(24).optional(),
        callback: z.string().max(300).optional(),
      })
      .parse(await c.req.json())

    const existing = accounts.getByController(body.controllerKey)
    if (existing.length > 0 && body.preferredNumber == null) {
      return c.json(
        {
          error: 'already_has_account',
          accounts: existing,
          note: 'Use preferredNumber for additional vanity mints, or transfer.',
        },
        409,
      )
    }

    let account
    try {
      account = await accounts.mint({
        controllerKey: body.controllerKey,
        displayName: body.displayName ?? '',
        bio: body.bio ?? '',
        kind: body.kind,
        preferredNumber: body.preferredNumber,
        mintTxid: body.mintTxid,
        network: body.network ?? defaultNetwork,
        skills: body.skills,
        capabilities: body.capabilities,
        callback: body.callback,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === 'number_taken') return c.json({ error: 'number_taken' }, 409)
      if (msg === 'invalid_number') return c.json({ error: 'invalid_number' }, 400)
      throw e
    }

    const createActionTemplate =
      body.ownerLockingScriptHex != null
        ? {
            description: `Mint AI Bounties account #${account.number}`,
            labels: [BRC100_LABELS.app, BRC100_LABELS.accountMint],
            outputs: buildMintAccountActionOutputs({
              ownerLockingScriptHex: body.ownerLockingScriptHex,
              mint: {
                accountNumber: account.number,
                controllerKeyHash: sha256Hex(body.controllerKey),
                kind: body.kind === 'agent' ? 1 : 0,
                nameLen: 0,
                displayName: account.displayName,
              },
            }),
          }
        : null

    return c.json(
      {
        account,
        createActionTemplate,
        note: createActionTemplate
          ? 'Broadcast createActionTemplate, then PATCH /v1/accounts/:n/mint-txid'
          : 'Indexed account. Provide ownerLockingScriptHex for 1sat mint template.',
      },
      201,
    )
  })

  app.get('/:number', (c) => {
    const n = Number(c.req.param('number'))
    if (!Number.isFinite(n)) return c.json({ error: 'invalid_number' }, 400)
    const a = accounts.getByNumber(n)
    if (!a) return c.json({ error: 'not_found' }, 404)
    return c.json({ ...a, reputation: reputationOf(a) })
  })

  app.patch('/:number/mint-txid', async (c) => {
    const n = Number(c.req.param('number'))
    const body = z.object({ mintTxid: z.string().min(8) }).parse(await c.req.json())
    const a = accounts.getByNumber(n)
    if (!a) return c.json({ error: 'not_found' }, 404)
    const session = c.get('session')
    if (session) {
      if (session.accountNumber !== n || session.controllerKey !== a.controllerKey) {
        return c.json({ error: 'forbidden' }, 403)
      }
    }
    const updated = await accounts.update(n, {
      mintTxid: body.mintTxid,
      originOutpoint: `${body.mintTxid}:0`,
    })
    return c.json(updated)
  })

  app.patch('/:number/profile', async (c) => {
    const n = Number(c.req.param('number'))
    const session = c.get('session')
    if (!session || session.accountNumber !== n) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const body = z
      .object({
        displayName: z.string().min(1).max(64).optional(),
        bio: z.string().max(500).optional(),
        kind: z.enum(['human', 'agent']).optional(),
        skills: z.array(z.string().min(1).max(40)).max(24).optional(),
        capabilities: z.array(z.string().min(1).max(40)).max(24).optional(),
        callback: z.string().max(300).optional(),
      })
      .parse(await c.req.json())
    const a = accounts.getByNumber(n)
    if (!a || a.controllerKey !== session.controllerKey) {
      return c.json({ error: 'forbidden' }, 403)
    }
    const updated = await accounts.update(n, body)
    return c.json(updated)
  })

  app.post('/:number/list', async (c) => {
    const n = Number(c.req.param('number'))
    const session = c.get('session')
    if (!session || session.accountNumber !== n) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const body = z
      .object({ priceSats: z.number().int().positive() })
      .parse(await c.req.json())
    const a = accounts.getByNumber(n)
    if (!a || a.controllerKey !== session.controllerKey) {
      return c.json({ error: 'forbidden' }, 403)
    }
    const updated = await accounts.update(n, {
      listPriceSats: body.priceSats,
      listedAt: new Date().toISOString(),
    })
    return c.json({
      account: updated,
      labels: [BRC100_LABELS.app, BRC100_LABELS.accountList],
    })
  })

  app.post('/:number/delist', async (c) => {
    const n = Number(c.req.param('number'))
    const session = c.get('session')
    if (!session || session.accountNumber !== n) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const a = accounts.getByNumber(n)
    if (!a || a.controllerKey !== session.controllerKey) {
      return c.json({ error: 'forbidden' }, 403)
    }
    const updated = await accounts.update(n, {
      listPriceSats: null,
      listedAt: null,
    })
    return c.json({ account: updated })
  })

  app.post('/:number/transfer', async (c) => {
    const n = Number(c.req.param('number'))
    const session = c.get('session')
    if (!session || session.accountNumber !== n) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const body = z
      .object({
        toControllerKey: z.string().min(4),
        transferTxid: z.string().optional(),
        priceSats: z.number().int().nonnegative().optional(),
      })
      .parse(await c.req.json())

    const a = accounts.getByNumber(n)
    if (!a || a.controllerKey !== session.controllerKey) {
      return c.json({ error: 'forbidden' }, 403)
    }

    const sellerKey = a.controllerKey
    const updated = await accounts.transfer(n, body.toControllerKey, {
      transferTxid: body.transferTxid,
      clearListing: true,
    })

    await sessions.revokeAccount(n)

    return c.json({
      account: updated,
      labels: [BRC100_LABELS.app, BRC100_LABELS.accountTransfer],
      note: 'Buyer should log in with toControllerKey and this account number.',
      previousController: sellerKey,
    })
  })

  /**
   * Preview atomic swap createAction (no ownership change yet).
   */
  app.post('/:number/swap-template', async (c) => {
    const n = Number(c.req.param('number'))
    const body = z
      .object({
        buyerControllerKey: z.string().min(4),
        sellerPaymentLockingScriptHex: z.string().optional(),
        buyerAccountLockingScriptHex: z.string().optional(),
      })
      .parse(await c.req.json())

    const a = accounts.getByNumber(n)
    if (!a) return c.json({ error: 'not_found' }, 404)
    if (a.listPriceSats == null || a.listPriceSats <= 0) {
      return c.json({ error: 'not_for_sale' }, 409)
    }

    const createActionTemplate = buildAtomicAccountSwapTemplate({
      accountNumber: n,
      priceSats: a.listPriceSats,
      sellerControllerKey: a.controllerKey,
      buyerControllerKey: body.buyerControllerKey,
      sellerPaymentLockingScriptHex: body.sellerPaymentLockingScriptHex,
      buyerAccountLockingScriptHex: body.buyerAccountLockingScriptHex,
    })

    return c.json({
      account: a,
      priceSats: a.listPriceSats,
      createActionTemplate,
      note: 'Broadcast with seller account 1-sat input + buyer payment. Then POST /buy with transferTxid.',
    })
  })

  app.post('/:number/buy', async (c) => {
    const n = Number(c.req.param('number'))
    const body = z
      .object({
        buyerControllerKey: z.string().min(4),
        transferTxid: z.string().optional(),
        /** When true (default), include atomic swap createActionTemplate in response. */
        includeSwapTemplate: z.boolean().optional().default(true),
        sellerPaymentLockingScriptHex: z.string().optional(),
        buyerAccountLockingScriptHex: z.string().optional(),
        /** If false, only return template without transferring (use swap-template). */
        commit: z.boolean().optional().default(true),
      })
      .parse(await c.req.json())

    const a = accounts.getByNumber(n)
    if (!a) return c.json({ error: 'not_found' }, 404)
    if (a.listPriceSats == null || a.listPriceSats <= 0) {
      return c.json({ error: 'not_for_sale' }, 409)
    }

    const price = a.listPriceSats
    const createActionTemplate = body.includeSwapTemplate
      ? buildAtomicAccountSwapTemplate({
          accountNumber: n,
          priceSats: price,
          sellerControllerKey: a.controllerKey,
          buyerControllerKey: body.buyerControllerKey,
          sellerPaymentLockingScriptHex: body.sellerPaymentLockingScriptHex,
          buyerAccountLockingScriptHex: body.buyerAccountLockingScriptHex,
        })
      : null

    if (!body.commit) {
      return c.json({
        account: a,
        paidSats: price,
        createActionTemplate,
        note: 'commit=false: template only. Set commit=true after broadcast to transfer ownership.',
      })
    }

    await sessions.revokeAccount(n)
    const updated = await accounts.transfer(n, body.buyerControllerKey, {
      transferTxid: body.transferTxid,
      clearListing: true,
    })

    const session = await sessions.create(body.buyerControllerKey, n)

    return c.json({
      account: updated,
      session: {
        token: session.token,
        expiresAt: session.expiresAt,
        accountNumber: n,
      },
      paidSats: price,
      createActionTemplate,
      labels: [
        BRC100_LABELS.app,
        BRC100_LABELS.accountTransfer,
        'account:atomic-swap',
      ],
      note: 'Phase 4: atomic swap template included. Prefer broadcast template first, then buy with transferTxid. Demo may commit index immediately.',
    })
  })

  return app
}
