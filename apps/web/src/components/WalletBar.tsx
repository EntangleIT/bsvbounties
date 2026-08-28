import { useEffect, useState } from 'react'
import {
  YOURS_CHROME,
  YOURS_SITE,
  connectYours,
  getIdentityKey,
  getWalletStatus,
  subscribeWallet,
  type WalletStatus,
} from '../lib/yours'

function shortKey(key: string | null): string {
  if (!key) return ''
  if (key.length < 12) return key
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

export function WalletBar() {
  const [status, setStatus] = useState<WalletStatus>(getWalletStatus())
  const [identity, setIdentity] = useState<string | null>(getIdentityKey())
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    return subscribeWallet(() => {
      setStatus(getWalletStatus())
      setIdentity(getIdentityKey())
    })
  }, [])

  async function onConnect() {
    setErr(null)
    try {
      await connectYours()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  if (status === 'detecting') {
    return <span className="pill">wallet: detecting…</span>
  }

  if (status === 'connected') {
    return (
      <span className="pill accent" title={identity ?? 'Yours'}>
        yours {shortKey(identity)}
      </span>
    )
  }

  if (status === 'available' || status === 'connecting') {
    return (
      <>
        <button
          type="button"
          className="pill btn-pill"
          disabled={status === 'connecting'}
          onClick={() => void onConnect()}
        >
          {status === 'connecting' ? 'Connecting…' : 'Connect Yours'}
        </button>
        {err && <span className="err small">{err}</span>}
      </>
    )
  }

  return (
    <a
      className="pill"
      href={YOURS_CHROME}
      target="_blank"
      rel="noreferrer"
      title={YOURS_SITE}
    >
      Install Yours Wallet
    </a>
  )
}
