import type { LlmMessage } from './types.js'

export function draftBountyMessages(opts: {
  roughIdea: string
  category?: string
}): LlmMessage[] {
  return [
    {
      role: 'system',
      content: `You help post clear AI Bounties on Bitcoin SV.
Return a concise JSON object only (no markdown) with keys:
title, description, category, requirements (string array).
Categories: dev, research, content, data, design, other.
Keep titles under 80 chars. Description under 800 chars.`,
    },
    {
      role: 'user',
      content: `Category hint: ${opts.category ?? 'other'}\nIdea:\n${opts.roughIdea}`,
    },
  ]
}

export function rankBountiesMessages(opts: {
  skills: string
  bounties: Array<{ id: string; title: string; description: string; amountSats: number }>
}): LlmMessage[] {
  return [
    {
      role: 'system',
      content: `You rank open bounties for a worker.
Return JSON only: { "rankedIds": ["id1","id2",...], "notes": "short reason" }.
Rank best-fit first.`,
    },
    {
      role: 'user',
      content: `Worker skills:\n${opts.skills}\n\nBounties:\n${JSON.stringify(opts.bounties, null, 2)}`,
    },
  ]
}
