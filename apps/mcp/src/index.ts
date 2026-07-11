#!/usr/bin/env node
/**
 * AI Bounties MCP server (Phase 4).
 *
 * Stdio transport for OpenClaw / Claude / Cursor agents.
 * Proxies to the REST API (AI_BOUNTIES_API_URL, default http://localhost:8787).
 *
 *   npm run build -w @ai-bounties/mcp
 *   AI_BOUNTIES_API_URL=http://localhost:8787 node apps/mcp/dist/index.js
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { api, apiBase } from './client.js'

const server = new McpServer({
  name: 'ai-bounties',
  version: '0.4.0',
})

function text(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  }
}

server.tool(
  'health',
  'Check AI Bounties API health and phase',
  {},
  async () => text(await api('/health')),
)

server.tool(
  'list_bounties',
  'List bounties (optional status filter: open|claimed|submitted|paid|refunded)',
  {
    status: z.string().optional(),
    limit: z.number().int().positive().max(100).optional(),
  },
  async ({ status, limit }) => {
    const q = new URLSearchParams()
    if (status) q.set('status', status)
    if (limit) q.set('limit', String(limit))
    const qs = q.toString()
    return text(await api(`/v1/bounties${qs ? `?${qs}` : ''}`))
  },
)

server.tool(
  'get_bounty',
  'Get a bounty by id including escrow metadata',
  { id: z.string() },
  async ({ id }) => text(await api(`/v1/bounties/${id}`)),
)

server.tool(
  'create_bounty',
  'Create a bounty with Phase 3 escrow when posterPubKey is set. May require poster bond.',
  {
    title: z.string(),
    description: z.string(),
    amountSats: z.number().int().positive(),
    category: z.string().optional(),
    posterPubKey: z.string().optional(),
    token: z.string().optional().describe('Bearer session token'),
    deadline: z.number().int().optional(),
    useEscrow: z.boolean().optional(),
  },
  async (args) => {
    const { token, useEscrow, ...rest } = args
    return text(
      await api('/v1/bounties', {
        method: 'POST',
        body: JSON.stringify({ ...rest, useEscrow: useEscrow ?? true }),
        token,
      }),
    )
  },
)

server.tool(
  'claim_bounty',
  'Claim an open bounty as worker',
  {
    id: z.string(),
    workerPubKey: z.string().optional(),
    token: z.string().optional(),
  },
  async ({ id, workerPubKey, token }) =>
    text(
      await api(`/v1/bounties/${id}/claim`, {
        method: 'POST',
        body: JSON.stringify({ workerPubKey }),
        token,
      }),
    ),
)

server.tool(
  'submit_work',
  'Submit work hash/uri for a claimed bounty',
  {
    id: z.string(),
    workHash: z.string(),
    workUri: z.string().optional(),
    token: z.string().optional(),
  },
  async ({ id, workHash, workUri, token }) =>
    text(
      await api(`/v1/bounties/${id}/submit`, {
        method: 'POST',
        body: JSON.stringify({ workHash, workUri }),
        token,
      }),
    ),
)

server.tool(
  'settle_bounty',
  'Approve pay or refund a bounty (poster)',
  {
    id: z.string(),
    outcome: z.enum(['paid', 'refunded']),
    token: z.string().optional(),
  },
  async ({ id, outcome, token }) =>
    text(
      await api(`/v1/bounties/${id}/settle`, {
        method: 'POST',
        body: JSON.stringify({ outcome }),
        token,
      }),
    ),
)

server.tool(
  'draft_bounty',
  'Use configured LLM (Grok) to draft a bounty from a rough idea',
  {
    roughIdea: z.string(),
    category: z.string().optional(),
  },
  async ({ roughIdea, category }) =>
    text(
      await api('/v1/llm/draft-bounty', {
        method: 'POST',
        body: JSON.stringify({ roughIdea, category }),
      }),
    ),
)

server.tool(
  'mint_account',
  'Mint a numbered AI Bounties account',
  {
    controllerKey: z.string(),
    displayName: z.string().optional(),
    kind: z.enum(['human', 'agent']).optional(),
    preferredNumber: z.number().int().positive().optional(),
  },
  async (body) =>
    text(
      await api('/v1/accounts/mint', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    ),
)

server.tool(
  'list_marketplace',
  'List numbered accounts for sale',
  {},
  async () => text(await api('/v1/accounts/marketplace')),
)

server.tool(
  'buy_account',
  'Buy a listed account; returns atomic swap createActionTemplate (Phase 4)',
  {
    number: z.number().int().positive(),
    buyerControllerKey: z.string(),
    commit: z
      .boolean()
      .optional()
      .describe('If false, only return swap template without transferring'),
    transferTxid: z.string().optional(),
  },
  async ({ number, buyerControllerKey, commit, transferTxid }) =>
    text(
      await api(`/v1/accounts/${number}/buy`, {
        method: 'POST',
        body: JSON.stringify({
          buyerControllerKey,
          commit: commit ?? true,
          transferTxid,
          includeSwapTemplate: true,
        }),
      }),
    ),
)

server.tool(
  'account_swap_template',
  'Get atomic swap createAction for a listed account without transferring yet',
  {
    number: z.number().int().positive(),
    buyerControllerKey: z.string(),
  },
  async ({ number, buyerControllerKey }) =>
    text(
      await api(`/v1/accounts/${number}/swap-template`, {
        method: 'POST',
        body: JSON.stringify({ buyerControllerKey }),
      }),
    ),
)

server.tool(
  'deposit_poster_bond',
  'Deposit a poster bond (required when REQUIRE_POSTER_BOND=true)',
  {
    controllerKey: z.string(),
    amountSats: z.number().int().positive(),
    token: z.string().optional(),
  },
  async ({ controllerKey, amountSats, token }) =>
    text(
      await api('/v1/bonds/deposit', {
        method: 'POST',
        body: JSON.stringify({ controllerKey, amountSats }),
        token,
      }),
    ),
)

server.tool(
  'get_poster_bond',
  'Get active poster bond for a controller key',
  { controllerKey: z.string() },
  async ({ controllerKey }) =>
    text(await api(`/v1/bonds/${encodeURIComponent(controllerKey)}`)),
)

server.tool(
  'auth_challenge',
  'Get login challenge for a controller key',
  { controllerKey: z.string() },
  async ({ controllerKey }) =>
    text(
      await api('/v1/auth/challenge', {
        method: 'POST',
        body: JSON.stringify({ controllerKey }),
      }),
    ),
)

server.tool(
  'auth_login',
  'Login with challenge signature (demo: sha256(message:controllerKey) hex)',
  {
    controllerKey: z.string(),
    challenge: z.string(),
    signature: z.string(),
    accountNumber: z.number().int().positive().optional(),
  },
  async (body) =>
    text(
      await api('/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    ),
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`AI Bounties MCP connected (API ${apiBase()})`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
