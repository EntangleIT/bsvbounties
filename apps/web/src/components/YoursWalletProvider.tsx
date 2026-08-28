import { useEffect, type ReactNode } from 'react'
import { WalletProvider, useWallet } from '@1sat/react'
import { registerConnect, syncFromProvider } from '../lib/yours'

function injectedProvider(): boolean {
  const w = window as Window & { yours?: unknown; bitcoin?: unknown }
  return Boolean(w.yours || w.bitcoin)
}

function YoursBridge({ children }: { children: ReactNode }) {
  const { wallet, status, identityKey, connect } = useWallet()

  useEffect(() => {
    registerConnect(() => connect())
  }, [connect])

  useEffect(() => {
    syncFromProvider({
      status,
      wallet: wallet ?? null,
      identityKey: identityKey ?? null,
      hasProviders: injectedProvider() || status !== 'disconnected',
    })
  }, [status, wallet, identityKey])

  useEffect(() => {
    function onEvent(e: Event) {
      const action = (e as CustomEvent<{ action?: string }>).detail?.action
      if (action === 'signedOut') {
        syncFromProvider({
          status: 'disconnected',
          wallet: null,
          identityKey: null,
          hasProviders: injectedProvider(),
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
    <WalletProvider autoReconnect>
      <YoursBridge>{children}</YoursBridge>
    </WalletProvider>
  )
}
