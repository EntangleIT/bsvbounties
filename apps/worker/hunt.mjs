#!/usr/bin/env node
/**
 * Reference worker loop:
 *   rank open bounties → claim a matching HTTP-check job → serve {"ok":true} → submit
 *
 *   AI_BOUNTIES_API_URL=http://localhost:8787 \
 *   WORKER_CONTROLLER=hunt-worker-1 \
 *   WORKER_SKILLS="http, json, apis" \
 *   node apps/worker/hunt.mjs
 *
 * Cursor / OpenClaw: point MCP at apps/mcp and use rank_bounties + claim_bounty + submit_work.
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const API = (process.env.AI_BOUNTIES_API_URL || 'http://localhost:8787').replace(
  /\/$/,
  '',
)
const workerKey = process.env.WORKER_CONTROLLER || 'hunt-worker-1'
const skills = process.env.WORKER_SKILLS || 'http, json, apis'

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`${method} ${path} ${res.status}: ${JSON.stringify(data)}`)
  }
  return data
}

function demoSig(message, controllerKey) {
  return createHash('sha256')
    .update(`${message}:${controllerKey}`)
    .digest('hex')
}

async function login() {
  try {
    await api('/v1/accounts/mint', {
      method: 'POST',
      body: {
        controllerKey: workerKey,
        displayName: 'Hunt worker',
        kind: 'agent',
        skills: skills.split(',').map((s) => s.trim()).filter(Boolean),
      },
    })
  } catch {
    /* exists */
  }
  const ch = await api('/v1/auth/challenge', {
    method: 'POST',
    body: { controllerKey: workerKey },
  })
  return api('/v1/auth/login', {
    method: 'POST',
    body: {
      controllerKey: workerKey,
      challenge: ch.challenge,
      signature: demoSig(ch.message, workerKey),
    },
  })
}

function startProbe() {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, url: `http://127.0.0.1:${port}/` })
    })
  })
}

async function main() {
  const session = await login()
  const ranked = await api('/v1/llm/rank-bounties', {
    method: 'POST',
    body: { skills, limit: 20 },
  })
  const listed = await api('/v1/bounties?status=open&limit=20')
  const byId = new Map((listed.items ?? []).map((b) => [b.id, b]))
  const order = (ranked.rankedIds ?? []).filter((id) => byId.has(id))
  const rest = (listed.items ?? []).filter((b) => !order.includes(b.id))
  const candidates = [...order.map((id) => byId.get(id)), ...rest]

  const target =
    candidates.find((b) => b.acceptance?.kind === 'http') ?? candidates[0]
  if (!target) {
    console.log('No open bounties.')
    return
  }
  console.log('claiming', target.id, target.title, target.acceptance?.kind)

  await api(`/v1/bounties/${target.id}/claim`, {
    method: 'POST',
    token: session.token,
    body: { workerPubKey: workerKey },
  })

  let workUri = target.acceptance?.url
  let probe
  if (!workUri && target.acceptance?.kind === 'http') {
    probe = await startProbe()
    workUri = probe.url
  }
  if (!workUri) {
    throw new Error('No work URI; set acceptance.url or use an HTTP-check bounty')
  }

  const submitted = await api(`/v1/bounties/${target.id}/submit`, {
    method: 'POST',
    token: session.token,
    body: { workUri },
  })
  probe?.server.close()

  console.log({
    status: submitted.bounty?.status,
    autoReleased: submitted.autoReleased,
    verification: submitted.verification,
    note: submitted.note,
  })
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
