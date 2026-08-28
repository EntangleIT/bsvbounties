#!/usr/bin/env node
/**
 * Tier 1 live API acceptance scorecard (no chain broadcast).
 *
 *   AI_BOUNTIES_API_URL=http://localhost:8787 node scripts/acceptance-api.mjs
 *
 * Scores: pass | demo-only | gap | fail
 * Exit 1 if any unexpected fail.
 */
import { createHash, randomBytes } from 'node:crypto'

const API = process.env.AI_BOUNTIES_API_URL || 'http://localhost:8787'
const posterKey = process.env.POSTER_CONTROLLER || 'accept-poster-1'
const workerKey = process.env.WORKER_CONTROLLER || 'accept-worker-1'
const saleKey = process.env.SALE_CONTROLLER || 'accept-sale-1'
const buyerKey = process.env.BUYER_CONTROLLER || 'accept-buyer-1'
/** Real compressed secp256k1 pubkey (test vector) — enables scrypt template path */
const realPosterPubKey =
  process.env.POSTER_PUBKEY ||
  '03717abfa1784ae3a010dc46985f11e5dc72231a5bad6274f7e6501ced5342f38c'
const demoPosterPubKey = 'poster-demo-key-not-ec'

const results = []

function demoSig(message, controllerKey) {
  return createHash('sha256')
    .update(`${message}:${controllerKey}`)
    .digest('hex')
}

function score(id, result, detail = '') {
  results.push({ id, result, detail })
  const mark =
    result === 'pass' ? 'PASS' : result === 'demo-only' ? 'DEMO' : result === 'gap' ? 'GAP' : 'FAIL'
  console.log(`[${mark}] ${id}${detail ? ` — ${detail}` : ''}`)
}

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  return { status: res.status, data }
}

async function mint(controllerKey, displayName) {
  const { status, data } = await api('/v1/accounts/mint', {
    method: 'POST',
    body: { controllerKey, displayName, kind: 'agent' },
  })
  if (status === 201 || status === 200) return data
  // already minted — login will resolve number
  return data
}

async function login(controllerKey) {
  const ch = await api('/v1/auth/challenge', {
    method: 'POST',
    body: { controllerKey },
  })
  if (ch.status !== 200) throw new Error(`challenge ${ch.status}`)
  const { status, data } = await api('/v1/auth/login', {
    method: 'POST',
    body: {
      controllerKey,
      challenge: ch.data.challenge,
      signature: demoSig(ch.data.message, controllerKey),
    },
  })
  if (status !== 200 || !data.token) {
    throw new Error(`login failed: ${JSON.stringify(data)}`)
  }
  return data
}

async function main() {
  console.log('API:', API)
  console.log('')

  // --- Discovery ---
  const health = await api('/health')
  if (
    health.status === 200 &&
    health.data?.ok !== false &&
    (health.data?.phase != null || health.data?.status)
  ) {
    score(
      'discovery.health',
      'pass',
      `phase=${health.data.phase} network=${health.data.network} escrow=${health.data.escrowMode} artifact=${health.data.scryptArtifact}`,
    )
  } else {
    score('discovery.health', 'fail', JSON.stringify(health.data))
  }

  const openapi = await api('/openapi.json')
  score(
    'discovery.openapi',
    openapi.status === 200 && openapi.data?.openapi ? 'pass' : 'fail',
    `status=${openapi.status}`,
  )

  const agent = await api('/.well-known/agent.json')
  score(
    'discovery.agent_card',
    agent.status === 200 && (agent.data?.name || agent.data?.url) ? 'pass' : 'fail',
    `status=${agent.status}`,
  )

  // --- Accounts / auth ---
  await mint(posterKey, 'Accept Poster')
  await mint(workerKey, 'Accept Worker')
  await mint(saleKey, 'Accept Sale')
  let posterLogin
  try {
    posterLogin = await login(posterKey)
    score(
      'accounts.mint_login',
      'demo-only',
      `account=#${posterLogin.account?.number} auth=demo`,
    )
  } catch (e) {
    score('accounts.mint_login', 'fail', e.message)
    throw e
  }
  const posterToken = posterLogin.token

  const workerLogin = await login(workerKey)
  const saleLogin = await login(saleKey)

  const profile = await api(`/v1/accounts/${posterLogin.account.number}/profile`, {
    method: 'PATCH',
    token: posterToken,
    body: { bio: 'acceptance-api profile' },
  })
  score(
    'accounts.profile',
    profile.status === 200 ? 'demo-only' : 'fail',
    `status=${profile.status}`,
  )

  // --- Bonds ---
  const bondDep = await api('/v1/bonds/deposit', {
    method: 'POST',
    token: posterToken,
    body: { controllerKey: posterKey, amountSats: 10_000 },
  })
  score(
    'bonds.deposit',
    bondDep.status === 201 && bondDep.data?.bond ? 'demo-only' : 'fail',
    `status=${bondDep.status} template=${!!bondDep.data?.createActionTemplate}`,
  )

  const bondGet = await api(`/v1/bonds/${encodeURIComponent(posterKey)}`)
  score(
    'bonds.get',
    bondGet.status === 200 && bondGet.data?.active ? 'pass' : 'fail',
    `meetsMinimum=${bondGet.data?.meetsMinimum}`,
  )

  const adminSecret = process.env.PLATFORM_ADMIN_SECRET
  if (adminSecret) {
    const slashRes = await fetch(`${API}/v1/bonds/slash`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-secret': adminSecret,
      },
      body: JSON.stringify({
        controllerKey: posterKey,
        reason: 'acceptance slash test',
      }),
    }).then(async (r) => ({ status: r.status, data: await r.json() }))
    score(
      'bonds.slash',
      slashRes.status === 200 ? 'pass' : 'fail',
      `status=${slashRes.status}`,
    )
    // re-deposit after slash for later bond-gate checks if needed
    await api('/v1/bonds/deposit', {
      method: 'POST',
      token: posterToken,
      body: { controllerKey: posterKey, amountSats: 10_000 },
    })
  } else {
    score(
      'bonds.slash',
      'demo-only',
      'skipped — set PLATFORM_ADMIN_SECRET to exercise',
    )
  }

  // UI gaps (static knowledge from codebase)
  score('ui.bonds', 'gap', 'no web UI for poster bonds')
  score('ui.escrow_edges', 'gap', 'cancel/refund/resolve not wired in UI')
  score('ui.atomic_swap', 'gap', 'no swap-template UI')

  // --- sCrypt deploy template (no session — login overwrites posterPubKey) ---
  const scryptCreate = await api('/v1/bounties', {
    method: 'POST',
    body: {
      title: 'Acceptance scrypt template',
      description: 'Unauthenticated create with compressed poster pubkey',
      category: 'dev',
      amountSats: 2000,
      posterPubKey: realPosterPubKey,
      useEscrow: true,
    },
  })
  const scryptNote = String(scryptCreate.data?.note ?? '')
  const scryptMode = scryptCreate.data?.bounty?.escrow?.mode
  const isScrypt =
    scryptCreate.status === 201 &&
    /sCrypt BountyEscrow deploy/i.test(scryptNote) &&
    scryptMode === 'scrypt'
  score(
    'escrow.scrypt_template',
    isScrypt ? 'pass' : scryptCreate.status === 201 ? 'demo-only' : 'fail',
    `status=${scryptCreate.status} mode=${scryptMode} note=${scryptNote.slice(0, 90)}`,
  )

  // --- Bounty happy path (session → app/P2PKH escrow, no broadcast) ---
  const created = await api('/v1/bounties', {
    method: 'POST',
    token: posterToken,
    body: {
      title: 'Acceptance happy path',
      description: 'Tier 1 API scorecard bounty',
      category: 'dev',
      amountSats: 5000,
      useEscrow: true,
      deadline: Math.floor(Date.now() / 1000) + 86400 * 30,
    },
  })
  const bountyId = created.data?.bounty?.id

  if (!bountyId) {
    score('bounty.lifecycle', 'fail', `no bounty id status=${created.status}`)
    score('escrow.attach_txid', 'fail', 'skipped')
  } else {
    const attach = await api(`/v1/bounties/${bountyId}/escrow`, {
      method: 'PATCH',
      body: { escrowTxid: `demo-accept-${randomBytes(8).toString('hex')}` },
    })
    score(
      'escrow.attach_txid',
      attach.status === 200 ? 'demo-only' : 'fail',
      'demo txid (no broadcast)',
    )

    const claimed = await api(`/v1/bounties/${bountyId}/claim`, {
      method: 'POST',
      token: workerLogin.token,
      body: { workerPubKey: workerKey },
    })
    const workHash = randomBytes(32).toString('hex')
    const submitted = await api(`/v1/bounties/${bountyId}/submit`, {
      method: 'POST',
      token: workerLogin.token,
      body: { workHash, workUri: 'accept://work' },
    })
    const settled = await api(`/v1/bounties/${bountyId}/settle`, {
      method: 'POST',
      token: posterToken,
      body: { outcome: 'paid' },
    })
    const ok =
      claimed.status === 200 &&
      submitted.status === 200 &&
      settled.status === 200 &&
      settled.data?.bounty?.status === 'paid'
    score(
      'bounty.lifecycle',
      ok ? 'demo-only' : 'fail',
      `claim=${claimed.status} submit=${submitted.status} settle=${settled.status} status=${settled.data?.bounty?.status}`,
    )
  }

  // --- Escrow edges (no session so posterPubKey stays the EC key) ---
  const arbiterKey = 'accept-arbiter-1'
  const openBounty = await api('/v1/bounties', {
    method: 'POST',
    body: {
      title: 'Acceptance cancel',
      description: 'Cancel while open',
      category: 'dev',
      amountSats: 2000,
      posterPubKey: realPosterPubKey,
      useEscrow: true,
    },
  })
  const openId = openBounty.data?.bounty?.id
  if (openId) {
    const cancel = await api(`/v1/bounties/${openId}/escrow/cancel`, {
      method: 'POST',
      body: { signerPubKey: realPosterPubKey },
    })
    score(
      'escrow.cancel_api',
      cancel.status === 200 ? 'pass' : 'fail',
      `status=${cancel.status} bounty=${cancel.data?.bounty?.status} err=${cancel.data?.error}`,
    )
  } else {
    score('escrow.cancel_api', 'fail', 'could not create open bounty')
  }

  const claimRefund = await api('/v1/bounties', {
    method: 'POST',
    body: {
      title: 'Acceptance early refund + resolve',
      description: 'Refund before deadline should fail; arbiter resolve pays worker',
      category: 'dev',
      amountSats: 2000,
      posterPubKey: realPosterPubKey,
      arbiterPubKey: arbiterKey,
      useEscrow: true,
      deadline: Math.floor(Date.now() / 1000) + 86400 * 365,
    },
  })
  const crId = claimRefund.data?.bounty?.id
  if (crId) {
    await api(`/v1/bounties/${crId}/claim`, {
      method: 'POST',
      body: { workerPubKey: workerKey },
    })
    const early = await api(`/v1/bounties/${crId}/escrow/refund`, {
      method: 'POST',
      body: { signerPubKey: realPosterPubKey },
    })
    const expected =
      early.status >= 400 || early.data?.error === 'deadline_not_reached'
    score(
      'escrow.refund_before_deadline',
      expected ? 'pass' : 'fail',
      `status=${early.status} error=${early.data?.error}`,
    )

    const resolve = await api(`/v1/bounties/${crId}/escrow/resolve`, {
      method: 'POST',
      body: { signerPubKey: arbiterKey, payWorker: true },
    })
    score(
      'escrow.resolve_api',
      resolve.status === 200 && resolve.data?.bounty?.status === 'paid'
        ? 'pass'
        : 'fail',
      `status=${resolve.status} bounty=${resolve.data?.bounty?.status} err=${resolve.data?.error}`,
    )
  } else {
    score('escrow.refund_before_deadline', 'fail', 'no bounty')
    score('escrow.resolve_api', 'fail', 'no bounty')
  }

  // Negative: demo pubkey → P2PKH fallback
  const fallback = await api('/v1/bounties', {
    method: 'POST',
    body: {
      title: 'P2PKH fallback check',
      description: 'Demo pubkey must not claim covenant',
      category: 'dev',
      amountSats: 1000,
      posterPubKey: demoPosterPubKey,
      useEscrow: true,
    },
  })
  const fbNote = String(fallback.data?.note ?? '')
  const fbMode = fallback.data?.bounty?.escrow?.mode
  const isFallback =
    fallback.status === 201 &&
    (fbMode === 'app' ||
      fbMode === 'p2pkh' ||
      /p2pkh|fallback|app/i.test(fbNote) ||
      fbMode !== 'scrypt')
  score(
    'escrow.demo_pubkey_fallback',
    isFallback ? 'pass' : 'fail',
    `mode=${fbMode} note=${fbNote.slice(0, 80)}`,
  )

  // --- Marketplace / swap ---
  const listed = await api(`/v1/accounts/${saleLogin.account.number}/list`, {
    method: 'POST',
    token: saleLogin.token,
    body: { priceSats: 33_000 },
  })
  score(
    'marketplace.list',
    listed.status === 200 ? 'pass' : 'fail',
    `status=${listed.status}`,
  )

  const swap = await api(`/v1/accounts/${saleLogin.account.number}/swap-template`, {
    method: 'POST',
    body: { buyerControllerKey: buyerKey },
  })
  const outs = swap.data?.createActionTemplate?.outputs?.length ?? 0
  score(
    'marketplace.swap_template',
    swap.status === 200 && outs >= 2 ? 'pass' : 'fail',
    `status=${swap.status} outputs=${outs}`,
  )

  const buy = await api(`/v1/accounts/${saleLogin.account.number}/buy`, {
    method: 'POST',
    body: {
      buyerControllerKey: buyerKey,
      commit: true,
      transferTxid: 'demo-accept-buy',
      includeSwapTemplate: true,
    },
  })
  score(
    'marketplace.buy',
    buy.status === 200 && buy.data?.account?.controllerKey === buyerKey
      ? 'demo-only'
      : 'fail',
    `controller=${buy.data?.account?.controllerKey}`,
  )

  // --- LLM ---
  const llmCfg = await api('/v1/llm/config')
  const draft = await api('/v1/llm/draft-bounty', {
    method: 'POST',
    body: { roughIdea: 'label 50 product photos' },
  })
  const mock = llmCfg.data?.mock === true || llmCfg.data?.provider === 'mock'
  score(
    'llm.draft',
    draft.status === 200
      ? mock
        ? 'demo-only'
        : 'pass'
      : 'fail',
    `status=${draft.status} mock=${mock} provider=${llmCfg.data?.provider}`,
  )

  // --- Covenant method calls (known gap) ---
  score(
    'escrow.scrypt_method_calls',
    'gap',
    'API does not track UTXO / call instance.methods.* yet',
  )

  // Summary
  console.log('')
  const counts = { pass: 0, 'demo-only': 0, gap: 0, fail: 0 }
  for (const r of results) counts[r.result] = (counts[r.result] ?? 0) + 1
  console.log('Scorecard:', counts)
  console.log(JSON.stringify({ api: API, health: health.data, results }, null, 2))

  if (counts.fail > 0) {
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
