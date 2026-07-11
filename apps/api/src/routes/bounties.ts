import { Hono } from 'hono'
import { z } from 'zod'
import {
  BRC100_LABELS,
  buildPostActionOutputs,
  categoryFromLabel,
  contentHash,
  generateBountyId,
  type Bounty,
  type Network,
} from '@ai-bounties/shared'
import type { BountyStore } from '../store/bountyStore.js'

const createSchema = z.object({
  title: z.string().min(3).max(120),
  description: z.string().min(10).max(8000),
  category: z.string().default('other'),
  requirements: z.array(z.string()).optional(),
  amountSats: z.number().int().positive(),
  posterPubKey: z.string().optional(),
  /** Hex locking script for poster P2PKH (escrow hold). If omitted, only indexes off-chain. */
  posterLockingScriptHex: z.string().optional(),
  escrowTxid: z.string().optional(),
  network: z.enum(['main', 'test']).optional(),
})

const claimSchema = z.object({
  workerPubKey: z.string().min(8),
  claimTxid: z.string().optional(),
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
})

export function bountyRoutes(store: BountyStore, defaultNetwork: Network) {
  const app = new Hono()

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

  /**
   * Create / register a bounty.
   * Returns the indexed bounty + optional BRC-100 createAction template.
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

    const bounty: Bounty = {
      id,
      title: body.title,
      description: body.description,
      category: body.category.toLowerCase(),
      requirements: body.requirements ?? [],
      amountSats: body.amountSats,
      contentHash: hash,
      status: 'open',
      posterPubKey: body.posterPubKey,
      escrowTxid: body.escrowTxid,
      createdAt: now,
      updatedAt: now,
      network: body.network ?? defaultNetwork,
    }

    await store.create(bounty)

    const createActionTemplate =
      body.posterLockingScriptHex != null
        ? {
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
        : null

    return c.json(
      {
        bounty,
        createActionTemplate,
        note: createActionTemplate
          ? 'Pass createActionTemplate to your BRC-100 wallet createAction(), then PATCH escrowTxid.'
          : 'Indexed off-chain only. Provide posterLockingScriptHex to get a BRC-100 action template.',
      },
      201,
    )
  })

  /** Attach broadcast txid after wallet createAction. */
  app.patch('/:id/escrow', async (c) => {
    const { escrowTxid } = z
      .object({ escrowTxid: z.string().min(8) })
      .parse(await c.req.json())
    const updated = await store.update(c.req.param('id'), { escrowTxid })
    if (!updated) return c.json({ error: 'not_found' }, 404)
    return c.json(updated)
  })

  app.post('/:id/claim', async (c) => {
    const body = claimSchema.parse(await c.req.json())
    const existing = store.get(c.req.param('id'))
    if (!existing) return c.json({ error: 'not_found' }, 404)
    if (existing.status !== 'open') {
      return c.json({ error: 'invalid_status', status: existing.status }, 409)
    }
    const updated = await store.update(existing.id, {
      status: 'claimed',
      workerPubKey: body.workerPubKey,
    })
    return c.json({
      bounty: updated,
      labels: [BRC100_LABELS.app, BRC100_LABELS.claim],
    })
  })

  app.post('/:id/submit', async (c) => {
    const body = submitSchema.parse(await c.req.json())
    const existing = store.get(c.req.param('id'))
    if (!existing) return c.json({ error: 'not_found' }, 404)
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
    if (!['claimed', 'submitted', 'open'].includes(existing.status)) {
      return c.json({ error: 'invalid_status', status: existing.status }, 409)
    }
    const updated = await store.update(existing.id, {
      status: body.outcome === 'paid' ? 'paid' : 'refunded',
      settleTxid: body.settleTxid,
    })
    return c.json({
      bounty: updated,
      labels: [BRC100_LABELS.app, BRC100_LABELS.settle],
    })
  })

  return app
}
