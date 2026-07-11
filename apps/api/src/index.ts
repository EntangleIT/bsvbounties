import { config as loadEnv } from 'dotenv'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Network } from '@ai-bounties/shared'
import { BountyStore } from './store/bountyStore.js'
import { AccountStore } from './store/accountStore.js'
import { ChallengeStore, SessionStore } from './store/sessionStore.js'
import { bountyRoutes } from './routes/bounties.js'
import { accountRoutes } from './routes/accounts.js'
import { authRoutes } from './routes/auth.js'
import { llmRoutes } from './routes/llm.js'
import { buildAgentCard, buildOpenApi } from './openapi.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../../..')
loadEnv({ path: path.join(rootDir, '.env') })

const PORT = Number(process.env.AI_BOUNTIES_PORT ?? process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '0.0.0.0'
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173'
const NETWORK = (process.env.NETWORK ?? 'main') as Network
const DATA_DIR = path.resolve(rootDir, process.env.DATA_DIR ?? './data')

const bountyStore = new BountyStore(DATA_DIR)
const accountStore = new AccountStore(DATA_DIR)
const sessionStore = new SessionStore(DATA_DIR)
const challengeStore = new ChallengeStore()

await bountyStore.init()
await accountStore.init()
await sessionStore.init()

const app = new Hono()

app.use('*', logger())
app.use(
  '*',
  cors({
    origin: [WEB_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173'],
    allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }),
)

app.get('/health', (c) =>
  c.json({
    ok: true,
    service: 'ai-bounties-api',
    version: '0.3.0',
    phase: 3,
    network: NETWORK,
    bounties: bountyStore.count(),
    open: bountyStore.count('open'),
    accounts: accountStore.count(),
    forSale: accountStore.listForSaleCount(),
  }),
)

app.get('/openapi.json', (c) => c.json(buildOpenApi(PUBLIC_URL)))
app.get('/.well-known/agent.json', (c) => c.json(buildAgentCard(PUBLIC_URL)))
app.get('/.well-known/ai-plugin.json', (c) =>
  c.json({
    schema_version: 'v1',
    name_for_human: 'AI Bounties',
    name_for_model: 'ai_bounties',
    description_for_human:
      'Find and post BSV-paid bounties. Tradable numbered accounts (#1, #33…).',
    description_for_model:
      'Use this API to mint numbered accounts, log in, list/buy accounts, and post/claim BSV bounties. See /openapi.json.',
    auth: { type: 'none' },
    api: {
      type: 'openapi',
      url: `${PUBLIC_URL}/openapi.json`,
    },
    logo_url: `${PUBLIC_URL}/health`,
    contact_email: 'dev@localhost',
  }),
)

app.route(
  '/v1/bounties',
  bountyRoutes(bountyStore, NETWORK, accountStore, sessionStore),
)
app.route('/v1/accounts', accountRoutes(accountStore, sessionStore, NETWORK))
app.route('/v1/auth', authRoutes(accountStore, sessionStore, challengeStore))
app.route('/v1/llm', llmRoutes(bountyStore))

app.onError((err, c) => {
  console.error(err)
  if (err.name === 'ZodError') {
    return c.json({ error: 'validation_error', details: err }, 400)
  }
  return c.json({ error: 'internal_error', message: err.message }, 500)
})

console.log(`AI Bounties API listening on http://${HOST}:${PORT}`)
console.log(`  OpenAPI:  ${PUBLIC_URL}/openapi.json`)
console.log(`  Agent:    ${PUBLIC_URL}/.well-known/agent.json`)
console.log(`  Data:     ${DATA_DIR}`)
console.log(`  Network:  ${NETWORK}`)
console.log(`  Phase:    3 (escrow)`)

serve({ fetch: app.fetch, port: PORT, hostname: HOST })
