import type { Bounty } from '@ai-bounties/shared'

const API_BASE = import.meta.env.VITE_API_URL ?? ''

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error ?? res.statusText)
  }
  return res.json() as Promise<T>
}

export interface ListResponse {
  items: Bounty[]
  total: number
}

export function listBounties(status?: string): Promise<ListResponse> {
  const q = status ? `?status=${encodeURIComponent(status)}` : ''
  return request(`/v1/bounties${q}`)
}

export function createBounty(body: {
  title: string
  description: string
  category: string
  requirements?: string[]
  amountSats: number
  posterPubKey?: string
  posterLockingScriptHex?: string
}): Promise<{
  bounty: Bounty
  createActionTemplate: {
    description: string
    labels: string[]
    outputs: Array<{ satoshis: number; lockingScript: string }>
  } | null
  note: string
}> {
  return request('/v1/bounties', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function claimBounty(id: string, workerPubKey: string) {
  return request(`/v1/bounties/${id}/claim`, {
    method: 'POST',
    body: JSON.stringify({ workerPubKey }),
  })
}

export function draftBounty(roughIdea: string, category?: string) {
  return request<{
    draft: {
      title?: string
      description?: string
      category?: string
      requirements?: string[]
    } | string
    provider: string
    model: string
  }>('/v1/llm/draft-bounty', {
    method: 'POST',
    body: JSON.stringify({ roughIdea, category }),
  })
}

export function getLlmConfig() {
  return request<{ provider: string; model: string; configured: boolean }>(
    '/v1/llm/config',
  )
}

export function attachEscrow(id: string, escrowTxid: string) {
  return request(`/v1/bounties/${id}/escrow`, {
    method: 'PATCH',
    body: JSON.stringify({ escrowTxid }),
  })
}
