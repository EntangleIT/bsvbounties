import { useEffect, useState } from 'react'
import type { Account, AccountReputation } from '@ai-bounties/shared'
import {
  authChallenge,
  authLogin,
  authLogout,
  authMe,
  buyAccount,
  delistAccount,
  getAuthToken,
  getMarketplace,
  listAccountForSale,
  mintAccount,
  setAuthToken,
  transferAccount,
  twetchComplete,
  twetchLogin,
  twetchUnlink,
  updateProfile,
} from '../lib/api'
import { ensureYoursConnected } from '../lib/wallet'

export function AccountPanel({
  account,
  onAccountChange,
}: {
  account: (Account & { reputation?: AccountReputation }) | null
  onAccountChange: (a: Account | null) => void
}) {
  const [displayName, setDisplayName] = useState('')
  const [bio, setBio] = useState('')
  const [skills, setSkills] = useState('')
  const [preferred, setPreferred] = useState('')
  const [listPrice, setListPrice] = useState(10_000_000)
  const [transferTo, setTransferTo] = useState('')
  const [marketplace, setMarketplace] = useState<
    Array<Account & { reputation?: AccountReputation }>
  >([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (getAuthToken()) {
      void authMe()
        .then((r) => onAccountChange(r.account))
        .catch(() => {
          setAuthToken(null)
          onAccountChange(null)
        })
    }
    void refreshMarket()
  }, [onAccountChange])

  // Twetch OIDC callback: issuer redirects here with ?code&state after the
  // user approves. Complete the link, then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const state = params.get('state')
    if (!code || !state || !getAuthToken()) return
    window.history.replaceState(null, '', window.location.pathname)
    setBusy(true)
    twetchComplete(code, state)
      .then((r) => {
        onAccountChange(r.account)
        setMsg(
          r.account.twetch?.handle
            ? `Verified as @${r.account.twetch.handle} ✓`
            : 'Twetch verified ✓',
        )
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (account) {
      setDisplayName(account.displayName)
      setBio(account.bio)
      setSkills((account.skills ?? []).join(', '))
    }
  }, [account])

  async function refreshMarket() {
    try {
      const m = await getMarketplace()
      setMarketplace(m.items)
    } catch {
      /* ignore */
    }
  }

  async function proveWallet() {
    const wallet = await ensureYoursConnected()
    const hint = await wallet.getIdentityKey()
    const ch = await authChallenge(hint)
    const signed = await wallet.signLogin(ch.message)
    return {
      wallet,
      controllerKey: signed.pubKey,
      challenge: ch.challenge,
      signature: signed.sig,
    }
  }

  async function loginWithProof(
    proof: {
      controllerKey: string
      challenge: string
      signature: string
    },
    accountNumber?: number,
  ) {
    const res = await authLogin({
      controllerKey: proof.controllerKey,
      challenge: proof.challenge,
      signature: proof.signature,
      accountNumber,
    })
    setAuthToken(res.token)
    onAccountChange(res.account)
    return res.account
  }

  async function onMint() {
    setBusy(true)
    setErr(null)
    setMsg(null)
    try {
      const proof = await proveWallet()
      const preferredNumber = preferred ? Number(preferred) : undefined
      const minted = await mintAccount({
        controllerKey: proof.controllerKey,
        displayName: displayName || undefined,
        bio: bio || undefined,
        kind: 'human',
        preferredNumber:
          preferredNumber && Number.isFinite(preferredNumber)
            ? preferredNumber
            : undefined,
      })
      if (minted.createActionTemplate) {
        const tx = await proof.wallet.createAction(
          minted.createActionTemplate as Parameters<
            typeof proof.wallet.createAction
          >[0],
        )
        if (tx.txid) {
          setMsg(`Minted #${minted.account.number}, tx ${tx.txid.slice(0, 12)}…`)
        }
      }
      await loginWithProof(proof, minted.account.number)
      setMsg((m) => m ?? `Minted & logged in as #${minted.account.number}`)
      await refreshMarket()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function onLogin() {
    setBusy(true)
    setErr(null)
    setMsg(null)
    try {
      const proof = await proveWallet()
      const a = await loginWithProof(proof)
      setMsg(`Logged in as #${a.number}`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function onVerifyTwetch() {
    setBusy(true)
    setErr(null)
    setMsg(null)
    try {
      const { authorizationUrl } = await twetchLogin()
      window.location.href = authorizationUrl
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  async function onUnlinkTwetch() {
    setBusy(true)
    setErr(null)
    try {
      const res = await twetchUnlink()
      onAccountChange(res.account)
      setMsg('Twetch verification removed')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function onLogout() {
    try {
      await authLogout()
    } catch {
      /* ignore */
    }
    setAuthToken(null)
    onAccountChange(null)
    setMsg('Logged out')
  }

  async function onSaveProfile() {
    if (!account) return
    setBusy(true)
    setErr(null)
    try {
      const updated = await updateProfile(account.number, {
        displayName,
        bio,
        skills: skills
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      })
      onAccountChange(updated)
      setMsg('Profile saved')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function onList() {
    if (!account) return
    setBusy(true)
    setErr(null)
    try {
      const res = await listAccountForSale(account.number, listPrice)
      onAccountChange(res.account)
      setMsg(`Listed #${account.number} for ${listPrice} sats`)
      await refreshMarket()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function onDelist() {
    if (!account) return
    setBusy(true)
    try {
      const res = await delistAccount(account.number)
      onAccountChange(res.account)
      setMsg('Delisted')
      await refreshMarket()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function onTransfer() {
    if (!account || !transferTo.trim()) return
    setBusy(true)
    setErr(null)
    try {
      await transferAccount(account.number, transferTo.trim())
      setAuthToken(null)
      onAccountChange(null)
      setMsg(`Transferred #${account.number} → ${transferTo.slice(0, 12)}…`)
      await refreshMarket()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function onBuy(n: number) {
    setBusy(true)
    setErr(null)
    try {
      const wallet = await ensureYoursConnected()
      const buyerKey = await wallet.getIdentityKey()
      const res = await buyAccount(n, buyerKey)
      setAuthToken(res.session.token)
      onAccountChange(res.account)
      setMsg(`Bought #${n} for ${res.paidSats} sats (app-assisted)`)
      await refreshMarket()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel account-panel">
      <h2>Accounts</h2>
      <p className="muted">
        Numbered identities (#33 style). Ownership = Yours Wallet key. Connect
        the extension, then mint or log in.
      </p>

      {account ? (
        <div className="account-badge">
          <span className="num">#{account.number}</span>
          <div>
            <strong>{account.displayName}</strong>
            <div className="muted small">
              {account.kind} · posted {account.stats.bountiesPosted} · claimed{' '}
              {account.stats.bountiesClaimed} · done{' '}
              {account.stats.bountiesCompleted}
              {account.stats.verifiesPassed + account.stats.verifiesFailed > 0 &&
                ` · verify ${(
                  (100 * account.stats.verifiesPassed) /
                  (account.stats.verifiesPassed + account.stats.verifiesFailed)
                ).toFixed(0)}%`}
              {account.stats.slashes > 0 && ` · slashes ${account.stats.slashes}`}
            </div>
            {account.reputation != null && (
              <div className="muted small">
                reputation {account.reputation.score} ({account.reputation.tier}
                {account.reputation.provisional ? ' · provisional' : ''})
              </div>
            )}
            {account.listPriceSats != null && account.listPriceSats > 0 && (
              <div className="listed">
                For sale: {account.listPriceSats.toLocaleString()} sats
              </div>
            )}
            <div className="muted small">
              {account.twetch?.sub ? (
                <>
                  ✓ Twetch verified
                  {account.twetch.handle ? ` as @${account.twetch.handle}` : ''}
                  {' · '}
                  <button
                    type="button"
                    className="chip"
                    disabled={busy}
                    onClick={() => void onUnlinkTwetch()}
                    title="Remove Twetch verification"
                  >
                    Unlink
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="chip"
                  disabled={busy}
                  onClick={() => void onVerifyTwetch()}
                  title="Verify with your Twetch account (one Twetch id per account)"
                >
                  Verify with Twetch
                </button>
              )}
            </div>
          </div>
          <button type="button" className="btn secondary slim" onClick={onLogout}>
            Log out
          </button>
        </div>
      ) : (
        <div className="row-actions">
          <button type="button" className="btn secondary" disabled={busy} onClick={onLogin}>
            Log in
          </button>
        </div>
      )}

      {!account && (
        <>
          <label>
            Display name
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Optional"
            />
          </label>
          <label>
            Bio
            <textarea
              rows={2}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="What you do"
            />
          </label>
          <label>
            Preferred # (optional vanity)
            <input
              value={preferred}
              onChange={(e) => setPreferred(e.target.value)}
              placeholder="e.g. 33 if free"
            />
          </label>
          <button type="button" className="btn primary" disabled={busy} onClick={onMint}>
            Mint account
          </button>
        </>
      )}

      {account && (
        <>
          <label>
            Display name
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>
          <label>
            Bio
            <textarea
              rows={2}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
            />
          </label>
          <label>
            Skills (comma-separated)
            <input
              value={skills}
              onChange={(e) => setSkills(e.target.value)}
              placeholder="http, typescript, research"
            />
          </label>
          <button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={onSaveProfile}
          >
            Save profile
          </button>

          <h3 className="subh">Sell / transfer</h3>
          <label>
            List price (sats)
            <input
              type="number"
              min={1}
              value={listPrice}
              onChange={(e) => setListPrice(Number(e.target.value))}
            />
          </label>
          <div className="row-actions">
            <button type="button" className="btn secondary" disabled={busy} onClick={onList}>
              List for sale
            </button>
            <button type="button" className="btn secondary" disabled={busy} onClick={onDelist}>
              Delist
            </button>
          </div>
          <label>
            Transfer to controller key
            <input
              value={transferTo}
              onChange={(e) => setTransferTo(e.target.value)}
              placeholder="buyer identity key"
            />
          </label>
          <button type="button" className="btn secondary" disabled={busy} onClick={onTransfer}>
            Transfer ownership
          </button>
        </>
      )}

      <h3 className="subh">Marketplace</h3>
      {marketplace.length === 0 ? (
        <p className="muted small">No accounts listed.</p>
      ) : (
        <ul className="market-list">
            {marketplace.map((a) => (
            <li key={a.number}>
              <span>
                <strong>#{a.number}</strong> {a.displayName} —{' '}
                {a.listPriceSats?.toLocaleString()} sats
                {a.reputation != null &&
                  ` · ★${a.reputation.score}${a.reputation.tier}`}
              </span>
              {(!account || account.number !== a.number) && (
                <button
                  type="button"
                  className="chip"
                  disabled={busy}
                  onClick={() => void onBuy(a.number)}
                >
                  Buy
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {msg && <p className="ok">{msg}</p>}
      {err && <p className="err">{err}</p>}
    </div>
  )
}
