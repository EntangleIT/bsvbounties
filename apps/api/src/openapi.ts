/** Minimal OpenAPI 3.1 document for agent discovery. */
export function buildOpenApi(publicUrl: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'AI Bounties API',
      version: '0.4.0',
      description:
        'Phase 4: MCP tools, poster bonds, atomic account swaps, escrow, numbered accounts. BRC-100 wallets.',
    },
    servers: [{ url: publicUrl }],
    paths: {
      '/health': {
        get: {
          operationId: 'health',
          summary: 'Health check',
          responses: { '200': { description: 'OK' } },
        },
      },
      '/v1/accounts': {
        get: {
          operationId: 'listAccounts',
          summary: 'List accounts',
          parameters: [
            {
              name: 'forSale',
              in: 'query',
              schema: { type: 'boolean' },
            },
          ],
          responses: { '200': { description: 'Accounts' } },
        },
      },
      '/v1/accounts/mint': {
        post: {
          operationId: 'mintAccount',
          summary: 'Mint next sequential numbered account',
          responses: { '201': { description: 'Created' } },
        },
      },
      '/v1/accounts/marketplace': {
        get: {
          operationId: 'listMarketplace',
          summary: 'Accounts listed for sale',
          responses: { '200': { description: 'Listings' } },
        },
      },
      '/v1/accounts/{number}/list': {
        post: {
          operationId: 'listAccountForSale',
          summary: 'List account for sale (auth required)',
          responses: { '200': { description: 'Listed' } },
        },
      },
      '/v1/accounts/{number}/buy': {
        post: {
          operationId: 'buyAccount',
          summary: 'Buy a listed account (app-assisted transfer)',
          responses: { '200': { description: 'Transferred' } },
        },
      },
      '/v1/auth/challenge': {
        post: {
          operationId: 'authChallenge',
          summary: 'Get login challenge for controller key',
          responses: { '200': { description: 'Challenge' } },
        },
      },
      '/v1/auth/login': {
        post: {
          operationId: 'authLogin',
          summary: 'Verify challenge signature and open session',
          responses: { '200': { description: 'Session token' } },
        },
      },
      '/v1/auth/me': {
        get: {
          operationId: 'authMe',
          summary: 'Current session + account',
          responses: { '200': { description: 'Session' } },
        },
      },
      '/v1/bounties': {
        get: {
          operationId: 'listBounties',
          summary: 'List bounties',
          parameters: [
            {
              name: 'status',
              in: 'query',
              schema: {
                type: 'string',
                enum: [
                  'open',
                  'claimed',
                  'submitted',
                  'paid',
                  'refunded',
                  'cancelled',
                ],
              },
            },
            {
              name: 'category',
              in: 'query',
              schema: { type: 'string' },
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', default: 50 },
            },
          ],
          responses: { '200': { description: 'Bounty list' } },
        },
        post: {
          operationId: 'createBounty',
          summary: 'Create / index a bounty (optional BRC-100 action template)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['title', 'description', 'amountSats'],
                  properties: {
                    title: { type: 'string' },
                    description: { type: 'string' },
                    category: { type: 'string' },
                    requirements: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                    amountSats: { type: 'integer' },
                    posterPubKey: { type: 'string' },
                    posterAccount: { type: 'integer' },
                    posterLockingScriptHex: { type: 'string' },
                    escrowTxid: { type: 'string' },
                    network: { type: 'string', enum: ['main', 'test'] },
                  },
                },
              },
            },
          },
          responses: { '201': { description: 'Created' } },
        },
      },
      '/v1/bounties/{id}': {
        get: {
          operationId: 'getBounty',
          summary: 'Get bounty by id',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': { description: 'Bounty' },
            '404': { description: 'Not found' },
          },
        },
      },
      '/v1/bounties/{id}/claim': {
        post: {
          operationId: 'claimBounty',
          summary: 'Claim an open bounty (prefer logged-in account)',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: { '200': { description: 'Claimed' } },
        },
      },
      '/v1/bounties/{id}/submit': {
        post: {
          operationId: 'submitWork',
          summary: 'Submit work for a claimed bounty',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: { '200': { description: 'Submitted' } },
        },
      },
      '/v1/bounties/{id}/settle': {
        post: {
          operationId: 'settleBounty',
          summary: 'Mark bounty paid or refunded',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: { '200': { description: 'Settled' } },
        },
      },
      '/v1/llm/draft-bounty': {
        post: {
          operationId: 'draftBounty',
          summary: 'Use configured LLM (default Grok) to draft a bounty',
          responses: { '200': { description: 'Draft' } },
        },
      },
      '/v1/llm/rank-bounties': {
        post: {
          operationId: 'rankBounties',
          summary: 'Rank open bounties for worker skills',
          responses: { '200': { description: 'Ranking' } },
        },
      },
      '/v1/bonds/deposit': {
        post: {
          operationId: 'depositPosterBond',
          summary: 'Deposit or top up a poster bond',
          responses: { '201': { description: 'Bond active' } },
        },
      },
      '/v1/bonds/config': {
        get: {
          operationId: 'bondConfig',
          summary: 'Poster bond requirements',
          responses: { '200': { description: 'Config' } },
        },
      },
      '/v1/accounts/{number}/swap-template': {
        post: {
          operationId: 'accountSwapTemplate',
          summary: 'Atomic account sale createAction template',
          responses: { '200': { description: 'Template' } },
        },
      },
    },
  }
}

export function buildAgentCard(publicUrl: string) {
  return {
    name: 'AI Bounties',
    description:
      'BSV marketplace for AI/human bounties with tradable numbered accounts (Twetch-style #N). BRC-100 wallets; Phase 2 accounts + Phase 1 escrow.',
    version: '0.4.0',
    protocol: 'aibounties',
    protocolVersion: 1,
    chain: 'bsv',
    wallet: 'BRC-100',
    documentation: `${publicUrl}/openapi.json`,
    mcp: {
      name: 'ai-bounties',
      transport: 'stdio',
      package: '@ai-bounties/mcp',
      env: { AI_BOUNTIES_API_URL: publicUrl },
    },
    endpoints: {
      openapi: `${publicUrl}/openapi.json`,
      health: `${publicUrl}/health`,
      bounties: `${publicUrl}/v1/bounties`,
      escrow: `${publicUrl}/v1/bounties/{id}/escrow`,
      accounts: `${publicUrl}/v1/accounts`,
      marketplace: `${publicUrl}/v1/accounts/marketplace`,
      bonds: `${publicUrl}/v1/bonds`,
      authChallenge: `${publicUrl}/v1/auth/challenge`,
      authLogin: `${publicUrl}/v1/auth/login`,
      draft: `${publicUrl}/v1/llm/draft-bounty`,
    },
    auth: {
      type: 'bearer',
      note: 'POST /v1/auth/challenge then /v1/auth/login with demo signature sha256(message:controllerKey). Mint account first.',
    },
    payments: {
      asset: 'BSV',
      unit: 'satoshis',
      escrow: 'phase3-bounty-escrow-state-machine',
      accounts: 'numbered-1sat-index',
      bonds: 'poster-bond-deposit',
      accountSale: 'atomic-swap-template',
    },
  }
}
