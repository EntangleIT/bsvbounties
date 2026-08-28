#!/usr/bin/env node
/**
 * HTTP-check golden path: poster posts a verifiable bounty, worker submits a
 * URL that returns {"ok":true}, platform auto-approves.
 *
 *   npm run build:libs
 *   npm run dev:api   # other terminal
 *   node apps/worker/golden-path.mjs
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const API = (process.env.AI_BOUNTIES_API_URL || 'http://localhost:8787').replace(
  /\/$/,
  '',
)
const posterKey = process.env.POSTER_CONTROLLER || 'golden-poster-1'
const workerKey = process.env.WORKER_CONTROLLER || 'golden-worker-1'

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

async function login(controllerKey) {
  try {
    await api('/v1/accounts/mint', {
      method: 'POST',
      body: {
        controllerKey,
        displayName: controllerKey,
        kind: 'agent',
        skills: ['http', 'json'],
      },
    })
  } catch {
    /* already minted */
  }
  const ch = await api('/v1/auth/challenge', {
    method: 'POST',
    body: { controllerKey },
  })
  return api('/v1/auth/login', {
    method: 'POST',
    body: {
      controllerKey,
      challenge: ch.challenge,
      signature: demoSig(ch.message, controllerKey),
    },
  })
}

function startProbe() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, path: req.url }))
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        server,
        url: `http://127.0.0.1:${port}/health`,
      })
    })
  })
}

async function main() {
  const health = await api('/health')
  console.log('API phase', health.phase, 'network', health.network)

  const probe = await startProbe()
  console.log('probe', probe.url)

  const poster = await login(posterKey)
  const worker = await login(workerKey)

  const created = await api('/v1/bounties', {
    method: 'POST',
    token: poster.token,
    body: {
      title: 'Golden path HTTP check',
      description: 'Return {"ok":true} at the submitted work URI.',
      category: 'dev',
      amountSats: 2500,
      posterPubKey: posterKey,
      useEscrow: true,
      arbiter: 'llm',
      acceptance: {
        kind: 'http',
        jsonPath: 'ok',
        expect: true,
        expectStatus: 200,
      },
    },
  })
  const id = created.bounty.id
  console.log('bounty', id, 'acceptance', created.bounty.acceptance)

  await api(`/v1/bounties/${id}/claim`, {
    method: 'POST',
    token: worker.token,
    body: { workerPubKey: workerKey },
  })

  const submitted = await api(`/v1/bounties/${id}/submit`, {
    method: 'POST',
    token: worker.token,
    body: { workUri: probe.url },
  })

  probe.server.close()

  console.log({
    status: submitted.bounty?.status,
    autoReleased: submitted.autoReleased,
    verification: submitted.verification,
    releasedSats: submitted.releasedSats,
  })

  if (!submitted.autoReleased || submitted.bounty?.status !== 'paid') {
    throw new Error(
      `expected auto-paid, got status=${submitted.bounty?.status} autoReleased=${submitted.autoReleased} reason=${submitted.verification?.reason}`,
    )
  }

  console.log('GOLDEN PATH OK')
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
