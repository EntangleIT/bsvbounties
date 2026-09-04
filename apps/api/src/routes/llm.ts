import { Hono } from 'hono'
import { z } from 'zod'
import {
  createLlmFromEnv,
  draftBountyMessages,
  rankBountiesMessages,
  rankWorkersMessages,
  type LlmClient,
} from '@ai-bounties/llm'
import { reputationOf } from '@ai-bounties/shared'
import type { BountyStore } from '../store/bountyStore.js'
import type { AccountStore } from '../store/accountStore.js'

export function llmRoutes(
  store: BountyStore,
  accounts?: AccountStore,
  client?: LlmClient,
) {
  const llm = client ?? createLlmFromEnv()
  const app = new Hono()

  app.get('/config', (c) => {
    return c.json({
      provider: llm.config.provider,
      model: llm.config.model,
      configured: llm.config.provider !== 'mock' || Boolean(llm.config.apiKey),
    })
  })

  app.post('/draft-bounty', async (c) => {
    const body = z
      .object({
        roughIdea: z.string().min(5).max(4000),
        category: z.string().optional(),
      })
      .parse(await c.req.json())

    const res = await llm.chat({
      messages: draftBountyMessages(body),
      temperature: 0.5,
    })

    let draft: unknown = res.content
    try {
      draft = JSON.parse(res.content)
    } catch {
      // leave as raw string
    }

    return c.json({
      draft,
      raw: res.content,
      provider: res.provider,
      model: res.model,
    })
  })

  app.post('/rank-bounties', async (c) => {
    const body = z
      .object({
        skills: z.string().min(2).max(2000),
        limit: z.number().int().positive().max(50).optional(),
      })
      .parse(await c.req.json())

    const open = store
      .list({ status: 'open', limit: body.limit ?? 20 })
      .map((b) => ({
        id: b.id,
        title: b.title,
        description: b.description,
        amountSats: b.amountSats,
      }))

    if (open.length === 0) {
      return c.json({ rankedIds: [], notes: 'No open bounties', open: [] })
    }

    const res = await llm.chat({
      messages: rankBountiesMessages({ skills: body.skills, bounties: open }),
      temperature: 0.2,
    })

    let parsed: { rankedIds?: string[]; notes?: string } = {}
    try {
      parsed = JSON.parse(res.content) as typeof parsed
    } catch {
      parsed = { notes: res.content }
    }

    return c.json({
      ...parsed,
      open,
      provider: res.provider,
      model: res.model,
    })
  })

  app.post('/rank-workers', async (c) => {
    const body = z
      .object({
        bountyId: z.string().optional(),
        skills: z.string().optional(),
        limit: z.number().int().positive().max(50).optional(),
      })
      .parse(await c.req.json())

    if (!accounts) {
      return c.json({ error: 'accounts_unavailable' }, 503)
    }

    const bounty = body.bountyId ? store.get(body.bountyId) : undefined
    const workers = accounts
      .list({ kind: 'agent', limit: body.limit ?? 40 })
      .concat(accounts.list({ kind: 'human', limit: body.limit ?? 40 }))
    const unique = [
      ...new Map(workers.map((w) => [w.number, w])).values(),
    ].slice(0, body.limit ?? 40)

    const payload = unique.map((w) => ({
      number: w.number,
      displayName: w.displayName,
      kind: w.kind,
      skills: w.skills,
      capabilities: w.capabilities,
      stats: w.stats,
      reputation: reputationOf(w),
    }))

    if (payload.length === 0) {
      return c.json({
        rankedNumbers: [],
        notes: 'No accounts to rank',
        workers: [],
      })
    }

    const res = await llm.chat({
      messages: rankWorkersMessages({
        bounty: bounty
          ? {
              id: bounty.id,
              title: bounty.title,
              description: bounty.description,
              amountSats: bounty.amountSats,
              category: bounty.category,
            }
          : {
              id: 'ad-hoc',
              title: body.skills ?? 'open work',
              description: body.skills ?? '',
              amountSats: 0,
            },
        workers: payload.map((w) => ({
          number: w.number,
          displayName: w.displayName,
          kind: w.kind,
          skills: w.skills,
          capabilities: w.capabilities,
          stats: w.stats,
        })),
      }),
      temperature: 0.2,
    })

    let parsed: { rankedNumbers?: number[]; notes?: string } = {}
    try {
      parsed = JSON.parse(res.content) as typeof parsed
    } catch {
      parsed = { notes: res.content }
    }

    return c.json({
      ...parsed,
      suggestedOrder: [...unique]
        .sort(
          (a, b) =>
            reputationOf(b).score - reputationOf(a).score || a.number - b.number,
        )
        .map((w) => w.number),
      workers: payload,
      provider: res.provider,
      model: res.model,
    })
  })

  return app
}
