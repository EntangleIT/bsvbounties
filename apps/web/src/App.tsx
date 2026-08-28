import { useCallback, useEffect, useState } from 'react'
import type { Account, Bounty } from '@ai-bounties/shared'
import {
  claimBounty,
  disputeBounty,
  getLlmConfig,
  listBounties,
  settleBounty,
  submitWork,
} from './lib/api'
import { ensureYoursConnected, walletMode } from './lib/wallet'
import { subscribeWallet } from './lib/yours'
import { BountyCard } from './components/BountyCard'
import { PostBountyForm } from './components/PostBountyForm'
import { AccountPanel } from './components/AccountPanel'
import { WalletBar } from './components/WalletBar'

export function App() {
  const [bounties, setBounties] = useState<Bounty[]>([])
  const [filter, setFilter] = useState<string>('open')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [llm, setLlm] = useState<{ provider: string; model: string } | null>(
    null,
  )
  const [account, setAccount] = useState<Account | null>(null)
  const [mode, setMode] = useState(walletMode())

  useEffect(() => subscribeWallet(() => setMode(walletMode())), [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await listBounties(filter || undefined)
      setBounties(res.items)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    void refresh()
    void getLlmConfig()
      .then((c) => setLlm({ provider: c.provider, model: c.model }))
      .catch(() => setLlm(null))
  }, [refresh])

  async function onClaim(id: string) {
    try {
      const wallet = await ensureYoursConnected()
      const workerPubKey = await wallet.getIdentityKey()
      await claimBounty(id, { workerPubKey })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function onSubmit(id: string, workUri: string) {
    try {
      const hash = workUri
        ? undefined
        : Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
      const res = (await submitWork(
        id,
        hash,
        workUri || undefined,
      )) as {
        autoReleased?: boolean
        verification?: { passed?: boolean; reason?: string }
        createActionTemplate?: Parameters<
          Awaited<ReturnType<typeof ensureYoursConnected>>['createAction']
        > extends (a: infer A) => unknown
          ? A
          : never
        approve?: { createActionTemplate?: unknown }
      }
      const template =
        res.createActionTemplate ??
        (res.approve as { createActionTemplate?: typeof res.createActionTemplate })
          ?.createActionTemplate
      if (template) {
        const wallet = await ensureYoursConnected()
        await wallet.createAction(template)
      }
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function onDispute(id: string) {
    try {
      await disputeBounty(id, 'UI dispute')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function onApprove(id: string) {
    try {
      const res = (await settleBounty(id, 'paid')) as {
        createActionTemplate?: {
          description: string
          labels: string[]
          outputs: Array<{ satoshis: number; lockingScript: string }>
        }
      }
      if (res.createActionTemplate) {
        const wallet = await ensureYoursConnected()
        await wallet.createAction(res.createActionTemplate)
      }
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">Bitcoin SV · BRC-100 · Phase 6</p>
          <h1>AI Bounties</h1>
          <p className="lede">
            Machine-verifiable jobs in BSV: agents find, prove, and get paid
            without a human clicking Approve. Numbered accounts carry reputation.
          </p>
        </div>
        <div className="status-pills">
          <WalletBar />
          <span className="pill">wallet: {mode}</span>
          {account && <span className="pill accent">#{account.number}</span>}
          {llm && (
            <span className="pill">
              llm: {llm.provider}/{llm.model}
            </span>
          )}
        </div>
      </header>

      <main className="layout layout-3">
        <section className="col-side">
          <AccountPanel account={account} onAccountChange={setAccount} />
        </section>

        <section className="col-main">
          <PostBountyForm onCreated={refresh} />

          <div className="board">
            <div className="board-head">
              <h2>Open board</h2>
              <div className="filters">
                {['open', 'claimed', 'submitted', 'paid', ''].map((s) => (
                  <button
                    key={s || 'all'}
                    type="button"
                    className={filter === s ? 'chip active' : 'chip'}
                    onClick={() => setFilter(s)}
                  >
                    {s || 'all'}
                  </button>
                ))}
                <button
                  type="button"
                  className="chip"
                  onClick={() => void refresh()}
                >
                  refresh
                </button>
              </div>
            </div>

            {loading && <p className="muted">Loading…</p>}
            {error && <p className="err">{error}</p>}
            {!loading && bounties.length === 0 && (
              <p className="muted">No bounties yet. Post the first one.</p>
            )}

            <div className="grid">
              {bounties.map((b) => (
                <BountyCard
                  key={b.id}
                  bounty={b}
                  onClaim={onClaim}
                  onSubmit={onSubmit}
                  onApprove={onApprove}
                  onDispute={onDispute}
                />
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <a
          href={`${import.meta.env.VITE_API_URL || ''}/openapi.json`}
          target="_blank"
          rel="noreferrer"
        >
          OpenAPI
        </a>
        <a
          href={`${import.meta.env.VITE_API_URL || ''}/.well-known/agent.json`}
          target="_blank"
          rel="noreferrer"
        >
          Agent card
        </a>
        <span>Protocol: aibounties v0.1 · Yours Wallet · Phase 6</span>
      </footer>
    </div>
  )
}
