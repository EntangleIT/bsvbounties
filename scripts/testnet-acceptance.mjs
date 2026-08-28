#!/usr/bin/env node
/**
 * Tier 3 testnet acceptance helpers.
 *
 * 1) fund-info / chain status
 * 2) Create API bounty with real compressed pubkey from BSV_TESTNET_WIF (sCrypt template)
 * 3) If wallet funded (≥2000 sats), run contracts deploy-demo and print WoC links
 * 4) Negative: demo pubkey → P2PKH fallback
 *
 * Broadcast of API createActionTemplate still needs a BRC-100 wallet (or extend this script).
 * Honest Pass today: deploy-demo tx visible on WoC + API sCrypt template.
 *
 *   set -a && source .env && set +a
 *   node scripts/testnet-acceptance.mjs
 */
import { spawn } from 'node:child_process'
import { PrivateKey } from '@bsv/sdk'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const API = process.env.AI_BOUNTIES_API_URL || 'http://localhost:8787'

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

function runNpmScript(script) {
  return new Promise((resolve) => {
    const child = spawn('npm', ['run', script, '-w', '@ai-bounties/contracts'], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d
      process.stdout.write(d)
    })
    child.stderr.on('data', (d) => {
      out += d
      process.stderr.write(d)
    })
    child.on('close', (code) => resolve({ code, out }))
  })
}

async function main() {
  const results = []
  const mark = (id, result, detail = '') => {
    results.push({ id, result, detail })
    console.log(`[${result.toUpperCase()}] ${id}${detail ? ` — ${detail}` : ''}`)
  }

  console.log('API:', API)
  const chain = await api('/v1/chain')
  if (chain.status !== 200) {
    mark('testnet.chain', 'fail', `status=${chain.status}`)
    console.log(JSON.stringify({ results }, null, 2))
    process.exit(1)
  }
  const bal =
    (chain.data?.wallet?.balance?.confirmed ?? 0) +
    (chain.data?.wallet?.balance?.unconfirmed ?? 0)
  const addr = chain.data?.wallet?.address
  mark(
    'testnet.chain',
    'pass',
    `network=${chain.data.network} balance=${bal} addr=${addr}`,
  )

  const wif = process.env.BSV_TESTNET_WIF
  if (!wif) {
    mark('testnet.wif', 'fail', 'BSV_TESTNET_WIF unset')
    console.log(JSON.stringify({ results }, null, 2))
    process.exit(1)
  }
  const pub = PrivateKey.fromWif(wif).toPublicKey().toString()
  mark('testnet.wif', 'pass', `pub=${pub.slice(0, 16)}…`)

  const created = await api('/v1/bounties', {
    method: 'POST',
    body: {
      title: 'Tier3 testnet sCrypt bounty',
      description: 'Created by testnet-acceptance.mjs with WIF-derived compressed pubkey',
      category: 'dev',
      amountSats: 2000,
      posterPubKey: pub,
      useEscrow: true,
    },
  })
  const note = String(created.data?.note ?? '')
  const mode = created.data?.bounty?.escrow?.mode
  const scryptOk =
    created.status === 201 &&
    mode === 'scrypt' &&
    /sCrypt BountyEscrow deploy/i.test(note)
  mark(
    'testnet.api_scrypt_template',
    scryptOk ? 'pass' : 'fail',
    `status=${created.status} mode=${mode} id=${created.data?.bounty?.id} note=${note.slice(0, 70)}`,
  )

  const fallback = await api('/v1/bounties', {
    method: 'POST',
    body: {
      title: 'Tier3 fallback check',
      description: 'Demo pubkey must use P2PKH hold',
      category: 'dev',
      amountSats: 1000,
      posterPubKey: 'not-an-ec-key',
      useEscrow: true,
    },
  })
  const fbNote = String(fallback.data?.note ?? '')
  mark(
    'testnet.demo_pubkey_fallback',
    /P2PKH|not a compressed/i.test(fbNote) ? 'pass' : 'fail',
    fbNote.slice(0, 90),
  )

  if (bal < 2000) {
    mark(
      'testnet.deploy_demo',
      'gap',
      `insufficient balance (${bal}). Fund ${addr} via https://bsvfaucet.com or other faucet, then re-run.`,
    )
    mark(
      'testnet.broadcast_attach',
      'gap',
      'blocked until wallet funded + BRC-100 broadcast of createActionTemplate',
    )
    console.log('\nScorecard:', results)
    console.log(
      JSON.stringify(
        {
          bountyId: created.data?.bounty?.id,
          explorerAddress: chain.data?.explorer
            ? `${chain.data.explorer}/address/${addr}`
            : null,
          faucets: chain.data?.faucets,
          results,
        },
        null,
        2,
      ),
    )
    process.exit(0)
  }

  console.log('\n--- deploy-demo ---')
  const deploy = await runNpmScript('testnet:deploy-demo')
  const txid = /Deployed txid:\s*([0-9a-fA-F]+)/.exec(deploy.out)?.[1]
  if (deploy.code === 0 && txid) {
    mark(
      'testnet.deploy_demo',
      'pass',
      `txid=${txid} https://test.whatsonchain.com/tx/${txid}`,
    )
  } else {
    mark('testnet.deploy_demo', 'fail', `exit=${deploy.code}`)
  }

  mark(
    'testnet.broadcast_attach',
    'gap',
    'API createActionTemplate broadcast + PATCH escrowTxid still requires BRC-100 wallet',
  )
  mark(
    'testnet.scrypt_method_calls',
    'gap',
    'covenant method-call settlement not wired through API',
  )

  console.log('\nScorecard:', results)
  console.log(JSON.stringify({ bountyId: created.data?.bounty?.id, txid, results }, null, 2))
  process.exit(results.some((r) => r.result === 'fail') ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
