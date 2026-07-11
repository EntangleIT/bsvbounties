import { useEffect, useState } from 'react'
import type { Account } from '@ai-bounties/shared'
import {
  authChallenge,
  authLogin,
  authLogout,
  authMe,
  buyAccount,
  delistAccount,
  demoSign,
  getAuthToken,
  getMarketplace,
  listAccountForSale,
  mintAccount,
  setAuthToken,
  transferAccount,
  updateProfile,
} from '../lib/api'
import { getWallet } from '../lib/wallet'

export function AccountPanel({
  account,
  onAccountChange,
}: {
  account: Account | null
  onAccountChange: (a: Account | null) => void
}) {
  const [displayName, setDisplayName] = useState('')
  const [bio, setBio] = useState('')
  const [preferred, setPreferred] = useState('')
  const [listPrice, setListPrice] = useState(10_000_000)
  const [transferTo, setTransferTo] = useState('')
  const [marketplace, setMarketplace] = useState<Account[]>([])
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

  useEffect(() => {
    if (account) {
      setDisplayName(account.displayName)
      setBio(account.bio)
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

  async function loginWithKey(controllerKey: string, accountNumber?: number) {
    const ch = await authChallenge(controllerKey)
    const signature = await demoSign(ch.message, controllerKey)
    const res = await authLogin({
      controllerKey,
      challenge: ch.challenge,
      signature,
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
      const wallet = getWallet()
      const controllerKey =
        (await wallet.getIdentityKey?.()) ?? 'demo-identity-key'
      const preferredNumber = preferred ? Number(preferred) : undefined
      const minted = await mintAccount({
        controllerKey,
        displayName: displayName || undefined,
        bio: bio || undefined,
        kind: 'human',
        preferredNumber:
          preferredNumber && Number.isFinite(preferredNumber)
            ? preferredNumber
            : undefined,
      })
      if (minted.createActionTemplate) {
        const tx = await wallet.createAction(
          minted.createActionTemplate as Parameters<
            typeof wallet.createAction
          >[0],
        )
        if (tx.txid) {
          setMsg(`Minted #${minted.account.number}, tx ${tx.txid.slice(0, 12)}…`)
        }
      }
      await loginWithKey(controllerKey, minted.account.number)
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
      const wallet = getWallet()
      const controllerKey =
        (await wallet.getIdentityKey?.()) ?? 'demo-identity-key'
      const a = await loginWithKey(controllerKey)
      setMsg(`Logged in as #${a.number}`)
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
      const wallet = getWallet()
      const buyerKey =
        (await wallet.getIdentityKey?.()) ??
        `demo-buyer-${crypto.randomUUID().slice(0, 8)}`
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
        Numbered identities (#33 style). Ownership = controller key. List and
        sell like Twetch.
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
            </div>
            {account.listPriceSats != null && account.listPriceSats > 0 && (
              <div className="listed">
                For sale: {account.listPriceSats.toLocaleString()} sats
              </div>
            )}
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
