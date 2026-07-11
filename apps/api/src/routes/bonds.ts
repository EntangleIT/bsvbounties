import { Hono } from 'hono'
import { z } from 'zod'
import { buildBondDepositTemplate } from '@ai-bounties/contracts'
import type { Network } from '@ai-bounties/shared'
import type { BondStore } from '../store/bondStore.js'
import type { SessionStore } from '../store/sessionStore.js'
import { getSessionFromRequest } from './auth.js'

export function bondRoutes(
  bonds: BondStore,
  sessions: SessionStore,
  defaultNetwork: Network,
) {
  const app = new Hono()
  const minBond = Number(process.env.POSTER_BOND_MIN_SATS ?? 10_000)
  const requireBond = process.env.REQUIRE_POSTER_BOND === 'true'

  app.get('/config', (c) =>
    c.json({
      requirePosterBond: requireBond,
      minBondSats: minBond,
      activeBonds: bonds.countActive(),
    }),
  )

  app.get('/', (c) => {
    const key = c.req.query('controllerKey') ?? undefined
    return c.json({ items: bonds.list(key), total: bonds.list(key).length })
  })

  app.get('/:controllerKey', (c) => {
    const key = c.req.param('controllerKey')
    const active = bonds.getActive(key)
    return c.json({
      active: active ?? null,
      history: bonds.list(key),
      meetsMinimum: bonds.meetsMinimum(key, minBond),
      minBondSats: minBond,
    })
  })

  app.post('/deposit', async (c) => {
    const body = z
      .object({
        controllerKey: z.string().min(4),
        amountSats: z.number().int().positive(),
        accountNumber: z.number().int().positive().optional(),
        depositTxid: z.string().optional(),
        vaultLockingScriptHex: z.string().optional(),
      })
      .parse(await c.req.json())

    const session = getSessionFromRequest(
      sessions,
      c.req.header('Authorization'),
    )
    const controllerKey = session?.controllerKey ?? body.controllerKey

    if (body.amountSats < minBond && !bonds.getActive(controllerKey)) {
      // First deposit must reach min if enforcement is on; still allow smaller top-ups later
      if (requireBond && body.amountSats < minBond) {
        return c.json(
          {
            error: 'below_minimum',
            minBondSats: minBond,
            note: `Deposit at least ${minBond} sats for a poster bond.`,
          },
          400,
        )
      }
    }

    const bond = await bonds.deposit({
      controllerKey,
      amountSats: body.amountSats,
      accountNumber: body.accountNumber ?? session?.accountNumber,
      depositTxid: body.depositTxid,
      network: defaultNetwork,
    })

    const createActionTemplate = buildBondDepositTemplate({
      amountSats: body.amountSats,
      controllerKey,
      vaultLockingScriptHex: body.vaultLockingScriptHex,
    })

    return c.json(
      {
        bond,
        createActionTemplate,
        note: 'Broadcast createActionTemplate, then optionally PATCH with depositTxid via another deposit call.',
      },
      201,
    )
  })

  app.post('/release', async (c) => {
    const body = z
      .object({
        controllerKey: z.string().min(4),
        releaseTxid: z.string().optional(),
      })
      .parse(await c.req.json())

    const session = getSessionFromRequest(
      sessions,
      c.req.header('Authorization'),
    )
    const controllerKey = session?.controllerKey ?? body.controllerKey
    if (session && session.controllerKey !== controllerKey) {
      return c.json({ error: 'forbidden' }, 403)
    }

    const bond = await bonds.release(controllerKey, body.releaseTxid)
    if (!bond) return c.json({ error: 'no_active_bond' }, 404)
    return c.json({ bond })
  })

  app.post('/slash', async (c) => {
    // Platform operator action (protect with secret in production)
    const secret = process.env.PLATFORM_ADMIN_SECRET
    if (secret && c.req.header('X-Admin-Secret') !== secret) {
      return c.json({ error: 'forbidden' }, 403)
    }
    const body = z
      .object({
        controllerKey: z.string().min(4),
        reason: z.string().min(3).max(500),
      })
      .parse(await c.req.json())

    const bond = await bonds.slash(body.controllerKey, body.reason)
    if (!bond) return c.json({ error: 'no_active_bond' }, 404)
    return c.json({ bond })
  })

  return app
}

export function bondGate(
  bonds: BondStore,
  controllerKey: string | undefined,
): { ok: true } | { ok: false; error: string; minBondSats: number } {
  const requireBond = process.env.REQUIRE_POSTER_BOND === 'true'
  if (!requireBond) return { ok: true }
  if (!controllerKey) {
    return {
      ok: false,
      error: 'poster_bond_required',
      minBondSats: Number(process.env.POSTER_BOND_MIN_SATS ?? 10_000),
    }
  }
  const min = Number(process.env.POSTER_BOND_MIN_SATS ?? 10_000)
  if (!bonds.meetsMinimum(controllerKey, min)) {
    return { ok: false, error: 'poster_bond_insufficient', minBondSats: min }
  }
  return { ok: true }
}
