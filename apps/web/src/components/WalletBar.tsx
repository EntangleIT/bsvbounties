import { useWallet } from '@1sat/react'
import { YOURS_CHROME, YOURS_SITE } from '../lib/yours'

function shortKey(key: string | null): string {
  if (!key) return ''
  if (key.length < 12) return key
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

export function WalletBar() {
  const { status, identityKey, connect, error } = useWallet()

  if (status === 'connected') {
    return (
      <span className="pill accent" title={identityKey ?? 'Yours'}>
        yours {shortKey(identityKey)}
      </span>
    )
  }

  if (status === 'detecting' || status === 'connecting' || status === 'selecting') {
    return (
      <span className="pill">
        {status === 'detecting' ? 'wallet: detecting…' : 'Connecting…'}
      </span>
    )
  }

  return (
    <>
      <button
        type="button"
        className="pill btn-pill"
        onClick={() => void connect()}
      >
        Connect Yours
      </button>
      <a
        className="pill"
        href={YOURS_CHROME}
        target="_blank"
        rel="noreferrer"
        title={YOURS_SITE}
      >
        Get Yours
      </a>
      {error && <span className="err small">{error.message}</span>}
    </>
  )
}
