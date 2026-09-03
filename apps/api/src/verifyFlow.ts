import {
  verifyWork,
  type AcceptanceSpec,
  type Bounty,
  type LlmJudgeInput,
  type LlmJudgeResult,
  type Rfc3161Stamp,
  type SealEnvelope,
  type SealSubmitter,
  type Verification,
} from '@ai-bounties/shared'
import type { LlmClient } from '@ai-bounties/llm'
import { arbiterMessages, llmJudgeMessages } from '@ai-bounties/llm'

function parseJudge(content: string): LlmJudgeResult {
  try {
    const p = JSON.parse(content) as Partial<LlmJudgeResult>
    return {
      pass: Boolean(p.pass),
      score: typeof p.score === 'number' ? p.score : p.pass ? 0.85 : 0.2,
      reason: typeof p.reason === 'string' ? p.reason : content.slice(0, 240),
      fraud: Boolean(p.fraud),
    }
  } catch {
    const fail = /\bfail\b/i.test(content)
    return {
      pass: !fail,
      score: fail ? 0.2 : 0.8,
      reason: content.slice(0, 240),
    }
  }
}

export function makeLlmJudge(llm: LlmClient) {
  return async (input: LlmJudgeInput): Promise<LlmJudgeResult> => {
    const res = await llm.chat({
      messages: llmJudgeMessages({
        title: input.title,
        description: input.description,
        requirements: input.requirements,
        rubric: input.spec.rubric ?? input.spec.prompt,
        workBody: input.workBody ?? '',
        notes: input.notes,
      }),
      temperature: 0.1,
    })
    return parseJudge(res.content)
  }
}

export async function runBountyVerifier(opts: {
  bounty: Bounty
  acceptance: AcceptanceSpec
  workUri?: string
  workHash?: string
  notes?: string
  llm?: LlmClient
  seal?: SealEnvelope
  expectedSubmitter?: SealSubmitter
  /** Platform TSA stamping for `sealed` + requireTimestamp. Defaults to live TSAs. */
  stamp?: (workHash: string) => Promise<Rfc3161Stamp>
}): Promise<Verification> {
  return verifyWork(
    {
      acceptance: opts.acceptance,
      workUri: opts.workUri,
      workHash: opts.workHash,
      notes: opts.notes,
      requirements: opts.bounty.requirements,
      title: opts.bounty.title,
      description: opts.bounty.description,
      seal: opts.seal,
      expectedSubmitter: opts.expectedSubmitter,
    },
    {
      llmJudge: opts.llm ? makeLlmJudge(opts.llm) : undefined,
      stamp: opts.stamp,
    },
  )
}

export async function runLlmArbiter(opts: {
  bounty: Bounty
  reason?: string
  llm: LlmClient
}): Promise<LlmJudgeResult> {
  let workBody = opts.bounty.workUri ?? ''
  if (opts.bounty.workUri?.startsWith('http')) {
    try {
      const res = await fetch(opts.bounty.workUri, {
        signal: AbortSignal.timeout(8000),
      })
      workBody = (await res.text()).slice(0, 12_000)
    } catch {
      workBody = `[fetch failed] ${opts.bounty.workUri}`
    }
  }
  const res = await opts.llm.chat({
    messages: arbiterMessages({
      title: opts.bounty.title,
      description: opts.bounty.description,
      requirements: opts.bounty.requirements,
      workUri: opts.bounty.workUri,
      workBody,
      disputeReason: opts.reason,
    }),
    temperature: 0.1,
  })
  return parseJudge(res.content)
}
