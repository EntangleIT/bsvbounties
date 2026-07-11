import type { Bounty } from '@ai-bounties/shared'

function satsLabel(sats: number): string {
  if (sats >= 100_000_000) return `${(sats / 100_000_000).toFixed(4)} BSV`
  if (sats >= 1000) return `${(sats / 1000).toFixed(1)}k sats`
  return `${sats} sats`
}

export function BountyCard({
  bounty,
  onClaim,
}: {
  bounty: Bounty
  onClaim?: (id: string) => void
}) {
  return (
    <article className="card">
      <div className="card-top">
        <span className={`badge status-${bounty.status}`}>{bounty.status}</span>
        <span className="badge category">{bounty.category}</span>
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
        {bounty.escrowTxid && (
          <span className="txid" title={bounty.escrowTxid}>
            tx {bounty.escrowTxid.slice(0, 8)}…
          </span>
        )}
      </div>
      {bounty.status === 'open' && onClaim && (
        <button type="button" className="btn secondary" onClick={() => onClaim(bounty.id)}>
          Claim
        </button>
      )}
    </article>
  )
}
