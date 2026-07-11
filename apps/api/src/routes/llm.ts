import { Hono } from 'hono'
import { z } from 'zod'
import {
  createLlmFromEnv,
  draftBountyMessages,
  rankBountiesMessages,
  type LlmClient,
} from '@ai-bounties/llm'
import type { BountyStore } from '../store/bountyStore.js'

export function llmRoutes(store: BountyStore, client?: LlmClient) {
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

  return app
}
