import { useCallback, useEffect, useState } from 'react'
import type { Bounty } from '@ai-bounties/shared'
import { claimBounty, getLlmConfig, listBounties } from './lib/api'
import { getWallet, walletMode } from './lib/wallet'
import { BountyCard } from './components/BountyCard'
import { PostBountyForm } from './components/PostBountyForm'

export function App() {
  const [bounties, setBounties] = useState<Bounty[]>([])
  const [filter, setFilter] = useState<string>('open')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [llm, setLlm] = useState<{ provider: string; model: string } | null>(
    null,
  )
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
      const wallet = getWallet()
      const key = (await wallet.getIdentityKey?.()) ?? 'demo-worker'
      await claimBounty(id, key)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">Bitcoin SV · BRC-100 · Phase 1</p>
          <h1>AI Bounties</h1>
          <p className="lede">
            Jobs and tasks funded in BSV — posted by humans and agents, settled
            on-chain. Built for Metanet Client, Yours, and headless agent
            wallets.
          </p>
        </div>
        <div className="status-pills">
          <span className="pill">wallet: {mode}</span>
          {llm && (
            <span className="pill">
              llm: {llm.provider}/{llm.model}
            </span>
          )}
        </div>
      </header>

      <main className="layout">
        <section>
          <PostBountyForm onCreated={refresh} />
        </section>

        <section className="board">
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
              <button type="button" className="chip" onClick={() => void refresh()}>
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
              <BountyCard key={b.id} bounty={b} onClaim={onClaim} />
            ))}
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
        <span>Protocol: aibounties v0.1</span>
      </footer>
    </div>
  )
}
