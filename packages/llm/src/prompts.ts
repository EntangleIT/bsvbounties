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

export function rankWorkersMessages(opts: {
  bounty: {
    id: string
    title: string
    description: string
    amountSats: number
    category?: string
  }
  workers: Array<{
    number: number
    displayName: string
    kind: string
    skills: string[]
    capabilities: string[]
    stats: {
      bountiesPosted: number
      bountiesCompleted: number
      bountiesClaimed: number
      verifiesPassed?: number
      verifiesFailed?: number
      slashes?: number
    }
  }>
}): LlmMessage[] {
  return [
    {
      role: 'system',
      content: `You rank numbered worker accounts for a bounty.
Return JSON only: { "rankedNumbers": [1, 2, ...], "notes": "short reason" }.
Best-fit first. Reputation and listed skills matter.`,
    },
    {
      role: 'user',
      content: `Bounty:\n${JSON.stringify(opts.bounty, null, 2)}\n\nWorkers:\n${JSON.stringify(opts.workers, null, 2)}`,
    },
  ]
}

export function llmJudgeMessages(opts: {
  title: string
  description: string
  requirements: string[]
  rubric?: string
  workBody: string
  notes?: string
}): LlmMessage[] {
  return [
    {
      role: 'system',
      content: `You score a work submission for an AI Bounty.
Return JSON only: { "pass": boolean, "score": number, "reason": string, "fraud": boolean }.
score is 0..1. fraud=true only if the artifact is clearly fabricated or malicious.`,
    },
    {
      role: 'user',
      content: `Title: ${opts.title}
Description: ${opts.description}
Requirements: ${JSON.stringify(opts.requirements)}
Rubric: ${opts.rubric?.trim() || 'Match requirements; deliverable must exist.'}
Notes: ${opts.notes ?? ''}
Work:
${opts.workBody.slice(0, 12000)}`,
    },
  ]
}

export function arbiterMessages(opts: {
  title: string
  description: string
  requirements: string[]
  workUri?: string
  workBody?: string
  notes?: string
  disputeReason?: string
}): LlmMessage[] {
  return [
    {
      role: 'system',
      content: `You are an escrow arbiter for an AI Bounty dispute.
Return JSON only: { "pass": boolean, "score": number, "reason": string, "fraud": boolean }.
pass=true means pay the worker. pass=false means refund the poster.`,
    },
    {
      role: 'user',
      content: `Title: ${opts.title}
Description: ${opts.description}
Requirements: ${JSON.stringify(opts.requirements)}
Dispute: ${opts.disputeReason ?? '(none)'}
Work URI: ${opts.workUri ?? ''}
Notes: ${opts.notes ?? ''}
Work:
${(opts.workBody ?? '').slice(0, 12000)}`,
    },
  ]
}
