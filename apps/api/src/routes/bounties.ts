import { Hono } from 'hono'
import { z } from 'zod'
import {
  BRC100_LABELS,
  buildPostActionOutputs,
  categoryFromLabel,
  contentHash,
  generateBountyId,
  type Bounty,
  type BountyEscrowMeta,
  type Network,
} from '@ai-bounties/shared'
import {
  applyTransition,
  bountyStatusFromEscrow,
  buildDeployEscrowTemplate,
  buildTransitionTemplate,
  escrowStateFromBountyStatus,
  initialSnapshot,
  type EscrowSnapshot,
  type EscrowMethod,
  EscrowState,
} from '@ai-bounties/contracts'
import type { BountyStore } from '../store/bountyStore.js'
import type { AccountStore } from '../store/accountStore.js'
import type { SessionStore } from '../store/sessionStore.js'
import type { BondStore } from '../store/bondStore.js'
import { getSessionFromRequest } from './auth.js'
import { bondGate } from './bonds.js'

const createSchema = z.object({
  title: z.string().min(3).max(120),
  description: z.string().min(10).max(8000),
  category: z.string().default('other'),
  requirements: z.array(z.string()).optional(),
  amountSats: z.number().int().positive(),
  posterPubKey: z.string().optional(),
  posterAccount: z.number().int().positive().optional(),
  /** Legacy Phase 1: simple P2PKH hold without escrow meta. */
  posterLockingScriptHex: z.string().optional(),
  /** Phase 3: deploy full escrow (state machine + param OP_RETURN). */
  useEscrow: z.boolean().optional().default(true),
  arbiterPubKey: z.string().optional(),
  /** Unix timestamp or block height; 0 = no timed refund. */
  deadline: z.number().int().nonnegative().optional(),
  feeBps: z.number().int().min(0).max(1000).optional(),
  feePkh: z.string().optional(),
  escrowTxid: z.string().optional(),
  network: z.enum(['main', 'test']).optional(),
})

const claimSchema = z.object({
  workerPubKey: z.string().min(4).optional(),
  workerAccount: z.number().int().positive().optional(),
  claimTxid: z.string().optional(),
  workerLockingScriptHex: z.string().optional(),
})

const submitSchema = z.object({
  workHash: z.string().min(16),
  workUri: z.string().optional(),
  notes: z.string().optional(),
  submitTxid: z.string().optional(),
})

const settleSchema = z.object({
  outcome: z.enum(['paid', 'refunded']),
  settleTxid: z.string().optional(),
  workerAddress: z.string().optional(),
  workerLockingScriptHex: z.string().optional(),
  feeLockingScriptHex: z.string().optional(),
})

const escrowActionSchema = z.object({
  signerPubKey: z.string().min(4),
  workerPubKey: z.string().optional(),
  workHash: z.string().optional(),
  payWorker: z.boolean().optional(),
  now: z.number().optional(),
  posterLockingScriptHex: z.string().optional(),
  workerLockingScriptHex: z.string().optional(),
  feeLockingScriptHex: z.string().optional(),
  txid: z.string().optional(),
})

function defaultFeeBps(): number {
  return Number(process.env.PLATFORM_FEE_BPS ?? 200)
}

function defaultFeePkh(): string {
  return process.env.PLATFORM_FEE_PKH ?? ''
}

function snapshotFromBounty(b: Bounty): EscrowSnapshot | null {
  if (b.escrow) {
    return {
      state: b.escrow.state as EscrowState,
      amountSats: b.amountSats,
      bountyId: b.id,
      contentHash: b.contentHash,
      posterPubKey: b.escrow.posterPubKey || b.posterPubKey || '',
      workerPubKey: b.escrow.workerPubKey || b.workerPubKey || '',
      arbiterPubKey: b.escrow.arbiterPubKey || '',
      deadline: b.escrow.deadline,
      workHash: b.workHash || '',
      feeBps: b.escrow.feeBps,
      feePkh: b.escrow.feePkh,
    }
  }
  if (!b.posterPubKey) return null
  return {
    state: escrowStateFromBountyStatus(b.status) as EscrowState,
    amountSats: b.amountSats,
    bountyId: b.id,
    contentHash: b.contentHash,
    posterPubKey: b.posterPubKey,
    workerPubKey: b.workerPubKey || '',
    arbiterPubKey: '',
    deadline: 0,
    workHash: b.workHash || '',
    feeBps: 0,
    feePkh: '',
  }
}

function metaFromSnapshot(
  s: EscrowSnapshot,
  mode: BountyEscrowMeta['mode'],
  extra?: Partial<BountyEscrowMeta>,
): BountyEscrowMeta {
  return {
    mode,
    state: s.state,
    posterPubKey: s.posterPubKey,
    workerPubKey: s.workerPubKey,
    arbiterPubKey: s.arbiterPubKey,
    deadline: s.deadline,
    feeBps: s.feeBps,
    feePkh: s.feePkh,
    ...extra,
  }
}

export function bountyRoutes(
  store: BountyStore,
  defaultNetwork: Network,
  accounts?: AccountStore,
  sessions?: SessionStore,
  bonds?: BondStore,
) {
  const app = new Hono()
  const requireAccounts = process.env.REQUIRE_ACCOUNT_FOR_CLAIM === 'true'

  app.get('/', (c) => {
    const status = c.req.query('status') as Bounty['status'] | undefined
    const category = c.req.query('category') ?? undefined
    const limit = Number(c.req.query('limit') ?? 50)
    const offset = Number(c.req.query('offset') ?? 0)
    const items = store.list({ status, category, limit, offset })
    return c.json({
      items,
      total: store.count(status),
      limit,
      offset,
    })
  })

  app.get('/:id', (c) => {
    const b = store.get(c.req.param('id'))
    if (!b) return c.json({ error: 'not_found' }, 404)
    return c.json(b)
  })

  app.get('/:id/escrow', (c) => {
    const b = store.get(c.req.param('id'))
    if (!b) return c.json({ error: 'not_found' }, 404)
    const snap = snapshotFromBounty(b)
    return c.json({
      bountyId: b.id,
      status: b.status,
      escrow: b.escrow ?? null,
      snapshot: snap,
      contract: {
        version: 1,
        source: 'packages/contracts/src/BountyEscrow.scrypt.ts',
        note: 'State machine enforced in app; sCrypt artifact optional for mainnet covenant.',
      },
    })
  })

  /**
   * Create / register a bounty with optional Phase 3 escrow deploy template.
   */
  app.post('/', async (c) => {
    const body = createSchema.parse(await c.req.json())
    const id = generateBountyId()
    const now = new Date().toISOString()
    const hash = contentHash({
      version: 1,
      title: body.title,
      description: body.description,
      category: body.category,
      requirements: body.requirements,
    })

    const session = sessions
      ? getSessionFromRequest(sessions, c.req.header('Authorization'))
      : undefined

    let posterAccount = body.posterAccount
    let posterPubKey = body.posterPubKey
    if (session && accounts) {
      const owned = accounts.getByNumber(session.accountNumber)
      if (!owned || owned.controllerKey !== session.controllerKey) {
        return c.json(
          {
            error: 'stale_session',
            note: 'Account ownership changed. Log in again.',
          },
          401,
        )
      }
      posterAccount = session.accountNumber
      posterPubKey = session.controllerKey
    }

    if (bonds) {
      const gate = bondGate(bonds, posterPubKey)
      if (!gate.ok) {
        return c.json(
          {
            error: gate.error,
            minBondSats: gate.minBondSats,
            note: `Deposit a poster bond of at least ${gate.minBondSats} sats via POST /v1/bonds/deposit (REQUIRE_POSTER_BOND=true).`,
          },
          403,
        )
      }
    }

    const useEscrow = body.useEscrow !== false
    let escrow: BountyEscrowMeta | undefined
    let createActionTemplate: unknown = null
    let note: string

    if (useEscrow && posterPubKey) {
      const snap = initialSnapshot({
        bountyId: id,
        contentHash: hash,
        amountSats: body.amountSats,
        posterPubKey,
        arbiterPubKey: body.arbiterPubKey,
        deadline: body.deadline,
        feeBps: body.feeBps ?? defaultFeeBps(),
        feePkh: body.feePkh ?? defaultFeePkh(),
      })
      escrow = metaFromSnapshot(snap, 'scrypt')
      createActionTemplate = buildDeployEscrowTemplate({
        snapshot: snap,
        title: body.title,
        category: body.category,
        posterLockingScriptHex: body.posterLockingScriptHex,
      })
      note =
        'Phase 3 escrow deploy template ready. createAction, then PATCH /escrow with txid.'
    } else if (body.posterLockingScriptHex) {
      createActionTemplate = {
        description: `Post AI Bounty: ${body.title}`,
        labels: [BRC100_LABELS.app, BRC100_LABELS.post],
        outputs: buildPostActionOutputs({
          amountSats: body.amountSats,
          posterLockingScriptHex: body.posterLockingScriptHex,
          post: {
            bountyId: id,
            amountSats: body.amountSats,
            contentHash: hash,
            category: categoryFromLabel(body.category),
            title: body.title,
          },
        }),
      }
      note =
        'Phase 1 P2PKH template. Prefer useEscrow=true for Phase 3 state machine.'
    } else {
      note =
        'Indexed off-chain only. Provide posterPubKey (and login) for escrow deploy template.'
    }

    const bounty: Bounty = {
      id,
      title: body.title,
      description: body.description,
      category: body.category.toLowerCase(),
      requirements: body.requirements ?? [],
      amountSats: body.amountSats,
      contentHash: hash,
      status: 'open',
      posterPubKey,
      posterAccount,
      escrowTxid: body.escrowTxid,
      escrow,
      createdAt: now,
      updatedAt: now,
      network: body.network ?? defaultNetwork,
    }

    await store.create(bounty)
    if (posterAccount != null && accounts) {
      await accounts.bumpStat(posterAccount, 'bountiesPosted')
    }

    return c.json({ bounty, createActionTemplate, note }, 201)
  })

  app.patch('/:id/escrow', async (c) => {
    const body = z
      .object({
        escrowTxid: z.string().min(8),
        outpoint: z.string().optional(),
      })
      .parse(await c.req.json())
    const existing = store.get(c.req.param('id'))
    if (!existing) return c.json({ error: 'not_found' }, 404)
    const escrow = existing.escrow
      ? {
          ...existing.escrow,
          lastTxid: body.escrowTxid,
          outpoint: body.outpoint ?? `${body.escrowTxid}:0`,
        }
      : undefined
    const updated = await store.update(c.req.param('id'), {
      escrowTxid: body.escrowTxid,
      escrow,
    })
    return c.json(updated)
  })

  async function runEscrowMethod(
    bountyId: string,
    method: EscrowMethod,
    body: z.infer<typeof escrowActionSchema>,
    sessionWorker?: { workerPubKey?: string; workerAccount?: number },
  ) {
    const existing = store.get(bountyId)
    if (!existing) return { error: 'not_found' as const, status: 404 as const }
    const snap = snapshotFromBounty(existing)
    if (!snap) {
      return {
        error: 'no_escrow' as const,
        status: 400 as const,
        note: 'Bounty has no escrow snapshot; recreate with useEscrow + posterPubKey.',
      }
    }

    const signer = body.signerPubKey
    const result = applyTransition(snap, {
      method,
      signerPubKey: signer,
      workerPubKey: body.workerPubKey ?? sessionWorker?.workerPubKey,
      workHash: body.workHash,
      payWorker: body.payWorker,
      now: body.now,
    })

    if (!result.ok) {
      return { error: result.error, status: 409 as const }
    }

    const template = buildTransitionTemplate({
      current: snap,
      transition: result,
      method,
      posterLockingScriptHex: body.posterLockingScriptHex,
      workerLockingScriptHex: body.workerLockingScriptHex,
      feeLockingScriptHex: body.feeLockingScriptHex,
    })

    const nextStatus = bountyStatusFromEscrow(result.next.state) as Bounty['status']
    const escrow = metaFromSnapshot(result.next, existing.escrow?.mode ?? 'scrypt', {
      lastTxid: body.txid,
      outpoint: body.txid ? `${body.txid}:0` : existing.escrow?.outpoint,
    })

    const patch: Partial<Bounty> = {
      status: nextStatus,
      escrow,
      workerPubKey: result.next.workerPubKey || existing.workerPubKey,
      workHash: result.next.workHash || existing.workHash,
    }
    if (sessionWorker?.workerAccount != null) {
      patch.workerAccount = sessionWorker.workerAccount
    }
    if (nextStatus === 'paid' || nextStatus === 'refunded') {
      patch.settleTxid = body.txid
    }

    const updated = await store.update(existing.id, patch)
    return {
      bounty: updated,
      transition: result,
      createActionTemplate: template,
      labels: template.labels,
    }
  }

  app.post('/:id/claim', async (c) => {
    const body = claimSchema.parse(await c.req.json())
    const existing = store.get(c.req.param('id'))
    if (!existing) return c.json({ error: 'not_found' }, 404)

    const session = sessions
      ? getSessionFromRequest(sessions, c.req.header('Authorization'))
      : undefined

    let workerAccount = body.workerAccount
    let workerPubKey = body.workerPubKey

    if (session) {
      workerAccount = session.accountNumber
      workerPubKey = session.controllerKey
    }

    if (requireAccounts && workerAccount == null) {
      return c.json(
        {
          error: 'account_required',
          note: 'Mint + login to claim bounties (REQUIRE_ACCOUNT_FOR_CLAIM=true).',
        },
        401,
      )
    }

    if (workerAccount != null && accounts) {
      const acc = accounts.getByNumber(workerAccount)
      if (!acc) return c.json({ error: 'invalid_worker_account' }, 400)
      workerPubKey = workerPubKey ?? acc.controllerKey
    }

    if (!workerPubKey) {
      return c.json({ error: 'worker_identity_required' }, 400)
    }

    // Phase 3 path when escrow meta present
    if (existing.escrow) {
      const action = await runEscrowMethod(
        existing.id,
        'claim',
        {
          signerPubKey: workerPubKey,
          workerPubKey,
          txid: body.claimTxid,
          workerLockingScriptHex: body.workerLockingScriptHex,
        },
        { workerPubKey, workerAccount },
      )
      if ('error' in action && action.error) {
        return c.json(action, action.status ?? 400)
      }
      if (workerAccount != null && accounts) {
        await accounts.bumpStat(workerAccount, 'bountiesClaimed')
      }
      return c.json(action)
    }

    // Legacy Phase 1/2 claim
    if (existing.status !== 'open') {
      return c.json({ error: 'invalid_status', status: existing.status }, 409)
    }
    const updated = await store.update(existing.id, {
      status: 'claimed',
      workerPubKey,
      workerAccount: workerAccount ?? undefined,
    })
    if (workerAccount != null && accounts) {
      await accounts.bumpStat(workerAccount, 'bountiesClaimed')
    }
    return c.json({
      bounty: updated,
      labels: [BRC100_LABELS.app, BRC100_LABELS.claim],
    })
  })

  app.post('/:id/submit', async (c) => {
    const body = submitSchema.parse(await c.req.json())
    const existing = store.get(c.req.param('id'))
    if (!existing) return c.json({ error: 'not_found' }, 404)

    if (existing.escrow) {
      const session = sessions
        ? getSessionFromRequest(sessions, c.req.header('Authorization'))
        : undefined
      const signer =
        session?.controllerKey ??
        existing.workerPubKey ??
        existing.escrow.workerPubKey
      if (!signer) return c.json({ error: 'worker_identity_required' }, 400)
      const action = await runEscrowMethod(existing.id, 'submit', {
        signerPubKey: signer,
        workHash: body.workHash,
        txid: body.submitTxid,
      })
      if ('error' in action && action.error) {
        return c.json(action, action.status ?? 400)
      }
      const withUri = await store.update(existing.id, {
        workUri: body.workUri,
      })
      return c.json({ ...action, bounty: withUri ?? action.bounty })
    }

    if (existing.status !== 'claimed' && existing.status !== 'submitted') {
      return c.json({ error: 'invalid_status', status: existing.status }, 409)
    }
    const updated = await store.update(existing.id, {
      status: 'submitted',
      workHash: body.workHash,
      workUri: body.workUri,
    })
    return c.json({
      bounty: updated,
      labels: [BRC100_LABELS.app, BRC100_LABELS.submit],
    })
  })

  app.post('/:id/settle', async (c) => {
    const body = settleSchema.parse(await c.req.json())
    const existing = store.get(c.req.param('id'))
    if (!existing) return c.json({ error: 'not_found' }, 404)

    if (existing.escrow) {
      const session = sessions
        ? getSessionFromRequest(sessions, c.req.header('Authorization'))
        : undefined
      const signer =
        session?.controllerKey ??
        existing.posterPubKey ??
        existing.escrow.posterPubKey
      if (!signer) return c.json({ error: 'poster_identity_required' }, 400)

      const method: EscrowMethod =
        body.outcome === 'paid' ? 'approve' : 'cancel'
      // refund uses deadline path when claimed; cancel only if open
      let action
      if (body.outcome === 'refunded' && existing.status !== 'open') {
        action = await runEscrowMethod(existing.id, 'refund', {
          signerPubKey: signer,
          txid: body.settleTxid,
          posterLockingScriptHex: undefined,
          workerLockingScriptHex: body.workerLockingScriptHex,
          feeLockingScriptHex: body.feeLockingScriptHex,
          now: Math.floor(Date.now() / 1000),
        })
        if ('error' in action && action.error === 'deadline_not_reached') {
          // Allow arbiter-less app-level refund for Phase 3 demo via cancel-style payout
          // only if still open; otherwise require deadline or resolve
          return c.json(
            {
              error: 'deadline_not_reached',
              note: 'Use POST /:id/escrow/resolve as arbiter, or wait for deadline.',
            },
            409,
          )
        }
      } else {
        action = await runEscrowMethod(existing.id, method, {
          signerPubKey: signer,
          txid: body.settleTxid,
          workerLockingScriptHex: body.workerLockingScriptHex,
          feeLockingScriptHex: body.feeLockingScriptHex,
        })
      }

      if ('error' in action && action.error) {
        return c.json(action, action.status ?? 400)
      }
      if (
        body.outcome === 'paid' &&
        existing.workerAccount != null &&
        accounts
      ) {
        await accounts.bumpStat(existing.workerAccount, 'bountiesCompleted')
      }
      return c.json(action)
    }

    if (!['claimed', 'submitted', 'open'].includes(existing.status)) {
      return c.json({ error: 'invalid_status', status: existing.status }, 409)
    }
    const updated = await store.update(existing.id, {
      status: body.outcome === 'paid' ? 'paid' : 'refunded',
      settleTxid: body.settleTxid,
    })
    if (
      body.outcome === 'paid' &&
      existing.workerAccount != null &&
      accounts
    ) {
      await accounts.bumpStat(existing.workerAccount, 'bountiesCompleted')
    }
    return c.json({
      bounty: updated,
      labels: [BRC100_LABELS.app, BRC100_LABELS.settle],
    })
  })

  // Explicit escrow methods (Phase 3)
  for (const method of [
    'claim',
    'submit',
    'approve',
    'cancel',
    'refund',
    'resolve',
  ] as EscrowMethod[]) {
    if (method === 'claim' || method === 'submit') continue // already have routes
    app.post(`/:id/escrow/${method}`, async (c) => {
      const body = escrowActionSchema.parse(await c.req.json())
      const session = sessions
        ? getSessionFromRequest(sessions, c.req.header('Authorization'))
        : undefined
      const signer = session?.controllerKey ?? body.signerPubKey
      const action = await runEscrowMethod(c.req.param('id'), method, {
        ...body,
        signerPubKey: signer,
      })
      if ('error' in action && action.error) {
        return c.json(action, action.status ?? 400)
      }
      if (
        method === 'approve' &&
        action.bounty?.workerAccount != null &&
        accounts
      ) {
        await accounts.bumpStat(action.bounty.workerAccount, 'bountiesCompleted')
      }
      return c.json(action)
    })
  }

  return app
}
