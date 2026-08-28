import { useEffect, type ReactNode } from 'react'
import { WalletProvider, useWallet } from '@1sat/react'
import { registerConnect, syncFromProvider } from '../lib/yours'

function YoursBridge({ children }: { children: ReactNode }) {
  const { wallet, status, identityKey, connect, availableProviders } = useWallet()

  useEffect(() => {
    registerConnect(() => connect())
  }, [connect])

  useEffect(() => {
    // Yours BRC-100 uses CWI / extension messaging, not window.yours.
    // `disconnected` is the idle installed state — same as SatPress.
    syncFromProvider({
      status,
      wallet: wallet ?? null,
      identityKey: identityKey ?? null,
      hasProviders: availableProviders.length > 0 || status !== 'disconnected',
    })
  }, [status, wallet, identityKey, availableProviders.length])

  useEffect(() => {
    function onEvent(e: Event) {
      const action = (e as CustomEvent<{ action?: string }>).detail?.action
      if (action === 'signedOut') {
        syncFromProvider({
          status: 'disconnected',
          wallet: null,
          identityKey: null,
          hasProviders: true,
        })
      }
    }
    window.addEventListener('YoursEmitEvent', onEvent)
    return () => window.removeEventListener('YoursEmitEvent', onEvent)
  }, [])

  return <>{children}</>
}

export function YoursWalletProvider({ children }: { children: ReactNode }) {
  return (
    <WalletProvider autoReconnect autoDetect>
      <YoursBridge>{children}</YoursBridge>
    </WalletProvider>
  )
}

