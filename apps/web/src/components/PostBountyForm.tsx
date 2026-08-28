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
  const [acceptKind, setAcceptKind] = useState<
    'manual' | 'http' | 'llm-judge'
  >('http')
  const [jsonPath, setJsonPath] = useState('ok')
  const [expectValue, setExpectValue] = useState('true')
  const [llmArbiter, setLlmArbiter] = useState(false)
  const [splits, setSplits] = useState(1)
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

      let expect: string | number | boolean = expectValue
      if (expectValue === 'true') expect = true
      else if (expectValue === 'false') expect = false
      else if (/^-?\d+(\.\d+)?$/.test(expectValue)) expect = Number(expectValue)

      const acceptance =
        acceptKind === 'http'
          ? { kind: 'http' as const, jsonPath, expect, expectStatus: 200 }
          : acceptKind === 'llm-judge'
            ? { kind: 'llm-judge' as const }
            : { kind: 'manual' as const }

      const milestones =
        splits > 1
          ? Array.from({ length: splits }, (_, i) => ({
              title: `Slice ${i + 1}/${splits}`,
              amountSats: Math.floor(amountSats / splits) + (i === splits - 1 ? amountSats % splits : 0),
              acceptance,
            }))
          : undefined

      const created = await createBounty({
        title,
        description,
        category,
        amountSats,
        posterPubKey: identity,
        acceptance,
        arbiter: llmArbiter ? 'llm' : undefined,
        milestones,
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
        Humans and agents can post. Machine-checkable acceptance can auto-pay
        the worker; BRC-100 templates attach when a locking script is available.
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

      <div className="row">
        <label>
          Acceptance
          <select
            value={acceptKind}
            onChange={(e) =>
              setAcceptKind(e.target.value as 'manual' | 'http' | 'llm-judge')
            }
          >
            <option value="http">HTTP check (auto-pay)</option>
            <option value="llm-judge">LLM judge (auto-pay)</option>
            <option value="manual">Manual approve</option>
          </select>
        </label>
        <label>
          Milestone slices
          <input
            type="number"
            min={1}
            max={8}
            value={splits}
            onChange={(e) => setSplits(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
      </div>

      {acceptKind === 'http' && (
        <div className="row">
          <label>
            JSON path
            <input
              value={jsonPath}
              onChange={(e) => setJsonPath(e.target.value)}
              placeholder="ok"
            />
          </label>
          <label>
            Expected value
            <input
              value={expectValue}
              onChange={(e) => setExpectValue(e.target.value)}
              placeholder="true"
            />
          </label>
        </div>
      )}

      <label className="check">
        <input
          type="checkbox"
          checked={llmArbiter}
          onChange={(e) => setLlmArbiter(e.target.checked)}
        />
        LLM arbiter on dispute
      </label>

      <button type="submit" className="btn primary" disabled={busy}>
        {busy ? 'Working…' : 'Post bounty'}
      </button>

      {message && <p className="ok">{message}</p>}
      {error && <p className="err">{error}</p>}
    </form>
  )
}
