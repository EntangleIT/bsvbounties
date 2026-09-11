/**
 * Internal agentpay bridge endpoints for agentpay-funded bounties.
 *
 * Server-to-server only: authenticated with the shared `x-agentpay-internal`
 * secret (AGENTPAY_WEBHOOK_SECRET) over the AGENTPAY service binding. These
 * bypass poster sessions because the poster is the agentpay platform, whose
 * escrow and charge were handled before the listing was created.
 */
import { Hono } from 'hono'
import type { BountyStore } from '../store/bountyStore.js'
import {
  createAgentpayBounty,
  postAgentpayEvent,
  settleAgentpayBounty,
  type AgentpayNotifier,
} from './bounties.js'

export function agentpayInternalRoutes(
  store: BountyStore,
  agentpay?: AgentpayNotifier | null,
) {
  const app = new Hono()

  app.use('*', async (c, next) => {
    const secret = (process.env.AGENTPAY_WEBHOOK_SECRET ?? '').trim()
    const provided = c.req.header('x-agentpay-internal') ?? ''
    if (!secret || provided !== secret) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
  })

  app.post('/bounties', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      const bounty = await createAgentpayBounty(store, {
        title: String(body.title ?? ''),
        description: String(body.description ?? ''),
        category: typeof body.category === 'string' ? body.category : undefined,
        amountSats: Number(body.amountSats ?? 0),
        deadline: typeof body.deadline === 'number' ? body.deadline : undefined,
        escrowTxid: String(body.escrowTxid ?? ''),
        posterRef: String(body.posterRef ?? 'agentpay'),
        feeBps: typeof body.feeBps === 'number' ? body.feeBps : undefined,
      })
      return c.json({ bounty }, 201)
    } catch (err) {
      return c.json(
        { error: 'invalid_bounty', message: err instanceof Error ? err.message : String(err) },
        400,
      )
    }
  })

  app.post('/bounties/:id/settle', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const outcome = body.outcome === 'refunded' ? 'refunded' : body.outcome === 'paid' ? 'paid' : null
    if (!outcome) return c.json({ error: 'invalid_outcome' }, 400)
    const txid = typeof body.txid === 'string' ? body.txid : undefined
    const result = await settleAgentpayBounty(store, c.req.param('id'), outcome, txid)
    if (result.error) return c.json(result, (result.status ?? 400) as 400 | 404 | 409)
    if (agentpay && result.bounty) {
      await postAgentpayEvent(agentpay, {
        bountyId: result.bounty.id,
        outcome,
        amountSats: result.bounty.amountSats,
        workerPubKey: result.bounty.workerPubKey,
        workerAccount: result.bounty.workerAccount,
        settleTxid: txid,
        title: result.bounty.title,
        category: result.bounty.category,
        funding: result.bounty.funding?.method ?? null,
        posterRef: result.bounty.posterPubKey ?? null,
      })
    }
    return c.json(result)
  })

  /** agentpay reports the on-chain payout/refund txid after the event. */
  app.patch('/bounties/:id/txid', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const txid = typeof body.txid === 'string' ? body.txid : ''
    if (!txid) return c.json({ error: 'txid_required' }, 400)
    const existing = store.get(c.req.param('id'))
    if (!existing) return c.json({ error: 'not_found' }, 404)
    const updated = await store.update(existing.id, { settleTxid: txid })
    return c.json({ bounty: updated ?? existing })
  })

  return app
}
