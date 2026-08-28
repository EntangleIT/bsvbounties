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
  version: '0.6.0',
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
  'Create a bounty (requires Bearer session token from auth_login). Optional escrow, acceptance, LLM arbiter.',
  {
    title: z.string(),
    description: z.string(),
    amountSats: z.number().int().positive(),
    category: z.string().optional(),
    posterPubKey: z
      .string()
      .optional()
      .describe('Ignored when token is set; poster comes from the session'),
    token: z
      .string()
      .describe('Bearer session token from auth_login (required)'),
    deadline: z.number().int().optional(),
    useEscrow: z.boolean().optional(),
    arbiter: z.string().optional().describe('"llm" or a pubkey'),
    acceptanceKind: z
      .enum(['manual', 'http', 'schema', 'command', 'hash', 'llm-judge'])
      .optional()
      .describe(
        'manual | http (JSON APIs) | schema | hash (sha256 of workUri) | llm-judge | command (alias of hash)',
      ),
    acceptanceRubric: z
      .string()
      .optional()
      .describe('Rubric/prompt for llm-judge'),
    acceptanceUrl: z.string().optional(),
    jsonPath: z.string().optional(),
    contentTypePrefix: z
      .string()
      .optional()
      .describe('Required Content-Type prefix, e.g. image/'),
    expectJson: z
      .string()
      .optional()
      .describe('JSON-encoded expected value for http jsonPath'),
  },
  async (args) => {
    const {
      token,
      useEscrow,
      arbiter,
      acceptanceKind,
      acceptanceUrl,
      acceptanceRubric,
      jsonPath,
      expectJson,
      contentTypePrefix,
      ...rest
    } = args
    let expect: unknown
    if (expectJson) {
      try {
        expect = JSON.parse(expectJson)
      } catch {
        expect = expectJson
      }
    }
    const acceptance = acceptanceKind
      ? {
          kind: acceptanceKind,
          url: acceptanceUrl,
          jsonPath,
          expect,
          contentTypePrefix,
          ...(acceptanceRubric ? { rubric: acceptanceRubric } : {}),
        }
      : undefined
    return text(
      await api('/v1/bounties', {
        method: 'POST',
        body: JSON.stringify({
          ...rest,
          useEscrow: useEscrow ?? true,
          arbiter,
          acceptance,
        }),
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
  'Submit work hash/uri for a claimed bounty (verifier may auto-approve)',
  {
    id: z.string(),
    workHash: z.string().optional(),
    workUri: z.string().optional(),
    notes: z.string().optional(),
    milestoneIndex: z.number().int().nonnegative().optional(),
    token: z.string().optional(),
  },
  async ({ id, workHash, workUri, notes, milestoneIndex, token }) =>
    text(
      await api(`/v1/bounties/${id}/submit`, {
        method: 'POST',
        body: JSON.stringify({ workHash, workUri, notes, milestoneIndex }),
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

server.tool(
  'rank_bounties',
  'Rank open bounties for worker skills (LLM)',
  {
    skills: z.string(),
    limit: z.number().int().positive().max(50).optional(),
  },
  async ({ skills, limit }) =>
    text(
      await api('/v1/llm/rank-bounties', {
        method: 'POST',
        body: JSON.stringify({ skills, limit }),
      }),
    ),
)

server.tool(
  'rank_workers',
  'Rank numbered accounts for a bounty (LLM)',
  {
    bountyId: z.string().optional(),
    skills: z.string().optional(),
  },
  async ({ bountyId, skills }) =>
    text(
      await api('/v1/llm/rank-workers', {
        method: 'POST',
        body: JSON.stringify({ bountyId, skills }),
      }),
    ),
)

server.tool(
  'escrow_cancel',
  'Cancel an OPEN escrow bounty (poster)',
  {
    id: z.string(),
    signerPubKey: z.string(),
    token: z.string().optional(),
  },
  async ({ id, signerPubKey, token }) =>
    text(
      await api(`/v1/bounties/${id}/escrow/cancel`, {
        method: 'POST',
        body: JSON.stringify({ signerPubKey }),
        token,
      }),
    ),
)

server.tool(
  'escrow_refund',
  'Refund after deadline (poster)',
  {
    id: z.string(),
    signerPubKey: z.string(),
    token: z.string().optional(),
  },
  async ({ id, signerPubKey, token }) =>
    text(
      await api(`/v1/bounties/${id}/escrow/refund`, {
        method: 'POST',
        body: JSON.stringify({
          signerPubKey,
          now: Math.floor(Date.now() / 1000),
        }),
        token,
      }),
    ),
)

server.tool(
  'escrow_resolve',
  'Arbiter resolve: pay worker or refund poster',
  {
    id: z.string(),
    signerPubKey: z.string(),
    payWorker: z.boolean(),
    token: z.string().optional(),
  },
  async ({ id, signerPubKey, payWorker, token }) =>
    text(
      await api(`/v1/bounties/${id}/escrow/resolve`, {
        method: 'POST',
        body: JSON.stringify({ signerPubKey, payWorker }),
        token,
      }),
    ),
)

server.tool(
  'dispute_bounty',
  'Open a dispute (LLM arbiter if the bounty was created with arbiter=llm)',
  {
    id: z.string(),
    reason: z.string().optional(),
    token: z.string().optional(),
  },
  async ({ id, reason, token }) =>
    text(
      await api(`/v1/bounties/${id}/dispute`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
        token,
      }),
    ),
)

server.tool(
  'deposit_worker_bond',
  'Deposit a worker bond (required when REQUIRE_WORKER_BOND=true)',
  {
    controllerKey: z.string(),
    amountSats: z.number().int().positive(),
    token: z.string().optional(),
  },
  async ({ controllerKey, amountSats, token }) =>
    text(
      await api('/v1/bonds/deposit', {
        method: 'POST',
        body: JSON.stringify({ controllerKey, amountSats, role: 'worker' }),
        token,
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
