import { Hono } from 'hono'
import { z } from 'zod'
import { buildBondDepositTemplate } from '@ai-bounties/contracts'
import type { BondRole, Network } from '@ai-bounties/shared'
import type { BondStore } from '../store/bondStore.js'
import type { SessionStore } from '../store/sessionStore.js'
import { getSessionFromRequest } from './auth.js'

function posterMin(): number {
  return Number(process.env.POSTER_BOND_MIN_SATS ?? 10_000)
}

function workerMin(): number {
  return Number(
    process.env.WORKER_BOND_MIN_SATS ?? process.env.POSTER_BOND_MIN_SATS ?? 10_000,
  )
}

export function bondRoutes(
  bonds: BondStore,
  sessions: SessionStore,
  defaultNetwork: Network,
) {
  const app = new Hono()

  app.get('/config', (c) =>
    c.json({
      requirePosterBond: process.env.REQUIRE_POSTER_BOND === 'true',
      requireWorkerBond: process.env.REQUIRE_WORKER_BOND === 'true',
      minBondSats: posterMin(),
      minWorkerBondSats: workerMin(),
      activeBonds: bonds.countActive(),
    }),
  )

  app.get('/', (c) => {
    const key = c.req.query('controllerKey') ?? undefined
    const role = c.req.query('role') as BondRole | undefined
    const items = bonds.list(key, role)
    return c.json({ items, total: items.length })
  })

  app.get('/:controllerKey', (c) => {
    const key = c.req.param('controllerKey')
    const poster = bonds.getActive(key, 'poster')
    const worker = bonds.getActive(key, 'worker')
    return c.json({
      active: poster ?? null,
      poster: poster ?? null,
      worker: worker ?? null,
      history: bonds.list(key),
      meetsMinimum: bonds.meetsMinimum(key, posterMin(), 'poster'),
      meetsWorkerMinimum: bonds.meetsMinimum(key, workerMin(), 'worker'),
      minBondSats: posterMin(),
      minWorkerBondSats: workerMin(),
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
        role: z.enum(['poster', 'worker']).optional().default('poster'),
      })
      .parse(await c.req.json())

    const session = getSessionFromRequest(
      sessions,
      c.req.header('Authorization'),
    )
    const controllerKey = session?.controllerKey ?? body.controllerKey
    const role = body.role
    const minBond = role === 'worker' ? workerMin() : posterMin()
    const requireBond =
      role === 'worker'
        ? process.env.REQUIRE_WORKER_BOND === 'true'
        : process.env.REQUIRE_POSTER_BOND === 'true'

    if (body.amountSats < minBond && !bonds.getActive(controllerKey, role)) {
      if (requireBond && body.amountSats < minBond) {
        return c.json(
          {
            error: 'below_minimum',
            minBondSats: minBond,
            role,
            note: `Deposit at least ${minBond} sats for a ${role} bond.`,
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
      role,
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
        role: z.enum(['poster', 'worker']).optional().default('poster'),
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

    const bond = await bonds.release(controllerKey, body.releaseTxid, body.role)
    if (!bond) return c.json({ error: 'no_active_bond' }, 404)
    return c.json({ bond })
  })

  app.post('/slash', async (c) => {
    const secret = process.env.PLATFORM_ADMIN_SECRET
    if (secret && c.req.header('X-Admin-Secret') !== secret) {
      return c.json({ error: 'forbidden' }, 403)
    }
    const body = z
      .object({
        controllerKey: z.string().min(4),
        reason: z.string().min(3).max(500),
        role: z.enum(['poster', 'worker']).optional().default('poster'),
      })
      .parse(await c.req.json())

    const bond = await bonds.slash(body.controllerKey, body.reason, body.role)
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
      minBondSats: posterMin(),
    }
  }
  const min = posterMin()
  if (!bonds.meetsMinimum(controllerKey, min, 'poster')) {
    return { ok: false, error: 'poster_bond_insufficient', minBondSats: min }
  }
  return { ok: true }
}

export function workerBondGate(
  bonds: BondStore,
  controllerKey: string | undefined,
): { ok: true } | { ok: false; error: string; minBondSats: number } {
  const requireBond = process.env.REQUIRE_WORKER_BOND === 'true'
  if (!requireBond) return { ok: true }
  if (!controllerKey) {
    return {
      ok: false,
      error: 'worker_bond_required',
      minBondSats: workerMin(),
    }
  }
  const min = workerMin()
  if (!bonds.meetsMinimum(controllerKey, min, 'worker')) {
    return { ok: false, error: 'worker_bond_insufficient', minBondSats: min }
  }
  return { ok: true }
}
