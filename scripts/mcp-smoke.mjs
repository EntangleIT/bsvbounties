#!/usr/bin/env node
/**
 * Smoke-test AI Bounties MCP tools over stdio (same path agents use).
 *
 *   AI_BOUNTIES_API_URL=http://localhost:8787 node scripts/mcp-smoke.mjs
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const mcpEntry = path.join(root, 'apps/mcp/dist/index.js')
const API = process.env.AI_BOUNTIES_API_URL || 'http://localhost:8787'

const posterPubKey =
  process.env.POSTER_PUBKEY ||
  '03717abfa1784ae3a010dc46985f11e5dc72231a5bad6274f7e6501ced5342f38c'
const posterKey = process.env.POSTER_CONTROLLER || 'poster-agent-mcp-1'
const workerKey = process.env.WORKER_CONTROLLER || 'worker-agent-mcp-1'

function demoSig(message, controllerKey) {
  return createHash('sha256')
    .update(`${message}:${controllerKey}`)
    .digest('hex')
}

class McpClient {
  constructor() {
    this.proc = spawn(process.execPath, [mcpEntry], {
      cwd: root,
      env: { ...process.env, AI_BOUNTIES_API_URL: API },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.buf = ''
    this.nextId = 1
    this.pending = new Map()
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk) => this.onData(chunk))
    this.proc.stderr.on('data', (d) => {
      process.stderr.write(`[mcp] ${d}`)
    })
    this.proc.on('exit', (code) => {
      for (const [, { reject }] of this.pending) {
        reject(new Error(`MCP exited ${code}`))
      }
    })
  }

  onData(chunk) {
    this.buf += chunk
    // MCP SDK stdio: newline-delimited JSON (not Content-Length)
    while (true) {
      const nl = this.buf.indexOf('\n')
      if (nl < 0) break
      const line = this.buf.slice(0, nl).replace(/\r$/, '').trim()
      this.buf = this.buf.slice(nl + 1)
      if (line) this.handleMessage(line)
    }
  }

  handleMessage(raw) {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  }

  request(method, params = {}) {
    const id = this.nextId++
    const payload =
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      }) + '\n'
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.proc.stdin.write(payload)
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`timeout ${method}`))
        }
      }, 30000)
    })
  }

  notify(method, params = {}) {
    this.proc.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n',
    )
  }

  async tool(name, args = {}) {
    const result = await this.request('tools/call', {
      name,
      arguments: args,
    })
    const text = result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(result)
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  close() {
    this.proc.kill()
  }
}

async function main() {
  console.log('API:', API)
  // health via HTTP first
  const h = await fetch(`${API}/health`).then((r) => r.json())
  console.log('health', {
    phase: h.phase,
    network: h.network,
    escrowMode: h.escrowMode,
    scrypt: h.scryptArtifact,
  })

  const mcp = new McpClient()
  await mcp.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'ai-bounties-smoke', version: '0.1.0' },
  })
  mcp.notify('notifications/initialized')

  const tools = await mcp.request('tools/list', {})
  console.log(
    'tools',
    tools.tools.map((t) => t.name).join(', '),
  )

  console.log('\n--- health tool ---')
  console.log(await mcp.tool('health'))

  console.log('\n--- mint poster account ---')
  let mint
  try {
    mint = await mcp.tool('mint_account', {
      controllerKey: posterKey,
      displayName: 'MCP Poster',
      kind: 'agent',
    })
    console.log(mint)
  } catch (e) {
    console.log('mint (maybe exists):', e.message)
  }

  console.log('\n--- auth poster ---')
  const ch = await mcp.tool('auth_challenge', { controllerKey: posterKey })
  const sig = demoSig(ch.message, posterKey)
  const login = await mcp.tool('auth_login', {
    controllerKey: posterKey,
    challenge: ch.challenge,
    signature: sig,
  })
  console.log('token', login.token?.slice(0, 16) + '…', 'account', login.account?.number)
  const token = login.token

  console.log('\n--- create bounty (escrow) ---')
  const created = await mcp.tool('create_bounty', {
    title: 'MCP smoke bounty',
    description: 'Posted via MCP smoke test. Claim and submit work.',
    amountSats: 5000,
    category: 'dev',
    posterPubKey,
    token,
    useEscrow: true,
  })
  console.log({
    id: created.bounty?.id,
    status: created.bounty?.status,
    escrowMode: created.bounty?.escrow?.mode,
    note: created.note,
    templateDesc: created.createActionTemplate?.description,
    outputs: created.createActionTemplate?.outputs?.length,
  })
  const bountyId = created.bounty?.id
  if (!bountyId) throw new Error('no bounty id')

  console.log('\n--- list open ---')
  const listed = await mcp.tool('list_bounties', { status: 'open', limit: 5 })
  console.log('open count', listed.total, 'items', listed.items?.length)

  console.log('\n--- claim as worker ---')
  const claimed = await mcp.tool('claim_bounty', {
    id: bountyId,
    workerPubKey: workerKey,
  })
  console.log({
    status: claimed.bounty?.status,
    worker: claimed.bounty?.workerPubKey,
    escrowState: claimed.bounty?.escrow?.state,
  })

  console.log('\n--- submit work ---')
  const workHash = randomBytes(32).toString('hex')
  const submitted = await mcp.tool('submit_work', {
    id: bountyId,
    workHash,
    workUri: 'mcp://smoke/work',
  })
  console.log({
    status: submitted.bounty?.status,
    workHash: submitted.bounty?.workHash?.slice(0, 16),
  })

  console.log('\n--- settle paid ---')
  const settled = await mcp.tool('settle_bounty', {
    id: bountyId,
    outcome: 'paid',
    token,
  })
  console.log({
    status: settled.bounty?.status,
    payout: settled.transition?.payout,
  })

  console.log('\n--- draft with LLM ---')
  try {
    console.log(await mcp.tool('draft_bounty', { roughIdea: 'label images for dataset' }))
  } catch (e) {
    console.log('draft', e.message)
  }

  // Phase 4: poster bonds
  console.log('\n--- deposit poster bond ---')
  const bondDeposit = await mcp.tool('deposit_poster_bond', {
    controllerKey: posterKey,
    amountSats: 10_000,
    token,
  })
  console.log({
    bondId: bondDeposit.bond?.id,
    amountSats: bondDeposit.bond?.amountSats,
    status: bondDeposit.bond?.status,
    templateOutputs: bondDeposit.createActionTemplate?.outputs?.length,
  })

  console.log('\n--- get poster bond ---')
  const bondGet = await mcp.tool('get_poster_bond', { controllerKey: posterKey })
  console.log({
    active: !!bondGet.active,
    meetsMinimum: bondGet.meetsMinimum,
    minBondSats: bondGet.minBondSats,
  })

  // Phase 4: marketplace + atomic swap (separate sale account)
  const saleKey = process.env.SALE_CONTROLLER || 'sale-agent-mcp-1'
  const buyerKey = process.env.BUYER_CONTROLLER || 'buyer-agent-mcp-1'

  console.log('\n--- mint sale account ---')
  let saleMint
  try {
    saleMint = await mcp.tool('mint_account', {
      controllerKey: saleKey,
      displayName: 'MCP Sale Account',
      kind: 'agent',
    })
    console.log({ number: saleMint.account?.number })
  } catch (e) {
    console.log('sale mint (maybe exists):', e.message)
    // Recover number via marketplace / re-login path below after listing needs number
  }

  const saleCh = await mcp.tool('auth_challenge', { controllerKey: saleKey })
  const saleLogin = await mcp.tool('auth_login', {
    controllerKey: saleKey,
    challenge: saleCh.challenge,
    signature: demoSig(saleCh.message, saleKey),
  })
  const saleToken = saleLogin.token
  const saleNumber = saleLogin.account?.number ?? saleMint?.account?.number
  if (!saleNumber) throw new Error('no sale account number')
  console.log('sale account', saleNumber)

  // list via REST (no MCP list tool) using fetch + sale token
  console.log('\n--- list account for sale (REST) ---')
  const listedSale = await fetch(`${API}/v1/accounts/${saleNumber}/list`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${saleToken}`,
    },
    body: JSON.stringify({ priceSats: 25_000 }),
  }).then((r) => r.json())
  if (listedSale.error) throw new Error(JSON.stringify(listedSale))
  console.log({
    number: listedSale.account?.number,
    listPriceSats: listedSale.account?.listPriceSats,
  })

  console.log('\n--- list_marketplace ---')
  const market = await mcp.tool('list_marketplace')
  console.log('marketplace total', market.total ?? market.items?.length)

  console.log('\n--- account_swap_template ---')
  const swap = await mcp.tool('account_swap_template', {
    number: saleNumber,
    buyerControllerKey: buyerKey,
  })
  console.log({
    priceSats: swap.priceSats,
    outputs: swap.createActionTemplate?.outputs?.length,
    description: swap.createActionTemplate?.description,
  })
  if (!swap.createActionTemplate?.outputs?.length) {
    throw new Error('swap template missing outputs')
  }

  console.log('\n--- buy_account (commit:false template only) ---')
  const buyPreview = await mcp.tool('buy_account', {
    number: saleNumber,
    buyerControllerKey: buyerKey,
    commit: false,
  })
  console.log({
    committed: buyPreview.account?.controllerKey === buyerKey,
    templateOutputs: buyPreview.createActionTemplate?.outputs?.length,
    note: buyPreview.note,
  })

  console.log('\n--- buy_account (commit:true demo index) ---')
  const bought = await mcp.tool('buy_account', {
    number: saleNumber,
    buyerControllerKey: buyerKey,
    commit: true,
    transferTxid: 'demo-mcp-smoke-transfer',
  })
  console.log({
    controllerKey: bought.account?.controllerKey,
    listPriceSats: bought.account?.listPriceSats,
  })
  if (bought.account?.controllerKey !== buyerKey) {
    throw new Error('buy did not transfer controller')
  }

  console.log('\nMCP smoke complete OK')
  mcp.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
