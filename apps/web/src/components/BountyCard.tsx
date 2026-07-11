import type { Bounty } from '@ai-bounties/shared'

function satsLabel(sats: number): string {
  if (sats >= 100_000_000) return `${(sats / 100_000_000).toFixed(4)} BSV`
  if (sats >= 1000) return `${(sats / 1000).toFixed(1)}k sats`
  return `${sats} sats`
}

const ESCROW_STATE: Record<number, string> = {
  0: 'OPEN',
  1: 'CLAIMED',
  2: 'SUBMITTED',
  3: 'PAID',
  4: 'REFUNDED',
}

export function BountyCard({
  bounty,
  onClaim,
  onSubmit,
  onApprove,
}: {
  bounty: Bounty
  onClaim?: (id: string) => void
  onSubmit?: (id: string) => void
  onApprove?: (id: string) => void
}) {
  return (
    <article className="card">
      <div className="card-top">
        <span className={`badge status-${bounty.status}`}>{bounty.status}</span>
        <span className="badge category">{bounty.category}</span>
        {bounty.escrow && (
          <span className="badge escrow" title="Phase 3 escrow">
            escrow {ESCROW_STATE[bounty.escrow.state] ?? bounty.escrow.state}
          </span>
        )}
        <span className="amount">{satsLabel(bounty.amountSats)}</span>
      </div>
      <h3>{bounty.title}</h3>
      <p className="desc">{bounty.description}</p>
      {bounty.requirements.length > 0 && (
        <ul className="reqs">
          {bounty.requirements.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <div className="card-meta">
        <code title={bounty.id}>{bounty.id.slice(0, 10)}…</code>
        {bounty.posterAccount != null && (
          <span className="acct">poster #{bounty.posterAccount}</span>
        )}
        {bounty.workerAccount != null && (
          <span className="acct">worker #{bounty.workerAccount}</span>
        )}
        {bounty.escrow?.feeBps != null && bounty.escrow.feeBps > 0 && (
          <span className="txid">fee {bounty.escrow.feeBps} bps</span>
        )}
        {bounty.escrowTxid && (
          <span className="txid" title={bounty.escrowTxid}>
            tx {bounty.escrowTxid.slice(0, 8)}…
          </span>
        )}
      </div>
      <div className="card-actions">
        {bounty.status === 'open' && onClaim && (
          <button type="button" className="btn secondary" onClick={() => onClaim(bounty.id)}>
            Claim
          </button>
        )}
        {(bounty.status === 'claimed' || bounty.status === 'submitted') && onSubmit && (
          <button type="button" className="btn secondary" onClick={() => onSubmit(bounty.id)}>
            Submit work
          </button>
        )}
        {(bounty.status === 'claimed' || bounty.status === 'submitted') && onApprove && (
          <button type="button" className="btn secondary" onClick={() => onApprove(bounty.id)}>
            Approve pay
          </button>
        )}
      </div>
    </article>
  )
}
