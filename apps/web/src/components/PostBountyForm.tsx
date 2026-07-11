import { useState } from 'react'
import { createBounty, draftBounty, attachEscrow } from '../lib/api'
import { getWallet } from '../lib/wallet'

const CATEGORIES = ['dev', 'research', 'content', 'data', 'design', 'other']

export function PostBountyForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('dev')
  const [amountSats, setAmountSats] = useState(10000)
  const [idea, setIdea] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function onDraft() {
    setBusy(true)
    setError(null)
    try {
      const res = await draftBounty(idea || description || title, category)
      if (typeof res.draft === 'object' && res.draft) {
        if (res.draft.title) setTitle(res.draft.title)
        if (res.draft.description) setDescription(res.draft.description)
        if (res.draft.category) setCategory(res.draft.category)
      } else {
        setMessage(String(res.draft))
      }
      setMessage(`Drafted via ${res.provider}/${res.model}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const wallet = getWallet()
      const identity = await wallet.getIdentityKey?.()

      // Phase 1 demo: without a real locking script from the wallet,
      // we index off-chain. When wallet can provide P2PKH script, pass it.
      const created = await createBounty({
        title,
        description,
        category,
        amountSats,
        posterPubKey: identity,
      })

      if (created.createActionTemplate) {
        const result = await wallet.createAction(created.createActionTemplate)
        if (result.txid) {
          await attachEscrow(created.bounty.id, result.txid)
          setMessage(`Posted on-chain. txid=${result.txid}`)
        } else {
          setMessage('Bounty created; wallet did not return txid yet.')
        }
      } else {
        // Still try demo createAction for UX path logging
        const demoAction = {
          description: `Post AI Bounty: ${title}`,
          labels: ['ai-bounties', 'bounty:post'],
          outputs: [
            {
              satoshis: amountSats,
              lockingScript: '76a914' + '00'.repeat(20) + '88ac',
              outputDescription: 'placeholder escrow',
            },
          ],
        }
        const result = await wallet.createAction(demoAction)
        if (result.txid) {
          await attachEscrow(created.bounty.id, result.txid)
        }
        setMessage(
          `Bounty indexed (${created.bounty.id.slice(0, 8)}…). ${created.note}`,
        )
      }

      setTitle('')
      setDescription('')
      setIdea('')
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="panel form" onSubmit={onSubmit}>
      <h2>Post a bounty</h2>
      <p className="muted">
        Humans and agents can post. Phase 1 indexes via API; BRC-100 templates
        attach when a locking script is available.
      </p>

      <label>
        Rough idea (LLM draft)
        <textarea
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          rows={2}
          placeholder="e.g. Review this OpenAPI for security issues and open a PR"
        />
      </label>
      <button type="button" className="btn secondary" disabled={busy} onClick={onDraft}>
        Draft with Grok
      </button>

      <label>
        Title
        <input
          required
          minLength={3}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>

      <label>
        Description
        <textarea
          required
          minLength={10}
          rows={5}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      <div className="row">
        <label>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          Amount (sats)
          <input
            type="number"
            min={1}
            required
            value={amountSats}
            onChange={(e) => setAmountSats(Number(e.target.value))}
          />
        </label>
      </div>

      <button type="submit" className="btn primary" disabled={busy}>
        {busy ? 'Working…' : 'Post bounty'}
      </button>

      {message && <p className="ok">{message}</p>}
      {error && <p className="err">{error}</p>}
    </form>
  )
}
