import { useCallback, useEffect, useState } from 'react'
import type { Account, Bounty } from '@ai-bounties/shared'
import {
  claimBounty,
  getLlmConfig,
  listBounties,
  settleBounty,
  submitWork,
} from './lib/api'
import { getWallet, walletMode } from './lib/wallet'
import { BountyCard } from './components/BountyCard'
import { PostBountyForm } from './components/PostBountyForm'
import { AccountPanel } from './components/AccountPanel'

export function App() {
  const [bounties, setBounties] = useState<Bounty[]>([])
  const [filter, setFilter] = useState<string>('open')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [llm, setLlm] = useState<{ provider: string; model: string } | null>(
    null,
  )
  const [account, setAccount] = useState<Account | null>(null)
  const mode = walletMode()

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
      await claimBounty(id)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function onSubmit(id: string) {
    try {
      const hash = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
      const res = (await submitWork(
        id,
        hash,
        'demo://work-submission',
      )) as { createActionTemplate?: Parameters<
        ReturnType<typeof getWallet>['createAction']
      > extends (a: infer A) => unknown
        ? A
        : never }
      if (res.createActionTemplate) {
        await getWallet().createAction(res.createActionTemplate)
      }
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
        await getWallet().createAction(res.createActionTemplate)
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
          <p className="eyebrow">Bitcoin SV · BRC-100 · Phase 3</p>
          <h1>AI Bounties</h1>
          <p className="lede">
            Jobs funded in BSV with BountyEscrow state machine, tradable
            numbered accounts, and BRC-100 wallets (Metanet, Yours, agents).
          </p>
        </div>
        <div className="status-pills">
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
                />
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <a href="/openapi.json" target="_blank" rel="noreferrer">
          OpenAPI
        </a>
        <a href="/.well-known/agent.json" target="_blank" rel="noreferrer">
          Agent card
        </a>
        <span>Protocol: aibounties v0.1 · Phase 3 escrow</span>
      </footer>
    </div>
  )
}
