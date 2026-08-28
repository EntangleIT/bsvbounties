/**
 * BRC-100 wallet client. Production uses Yours Wallet via @1sat/react.
 * Demo fake-txids are opt-in only (`VITE_ALLOW_DEMO_WALLET=true`).
 */
import {
  connectYours,
  createActionWithYours,
  getActiveContext,
  getIdentityKey,
  getWalletStatus,
  signLoginMessage,
  type CreateActionArgs,
  type CreateActionResult,
  type WalletStatus,
} from './yours'

export type { CreateActionArgs, CreateActionResult }

export interface Brc100Wallet {
  isAvailable(): boolean
  getIdentityKey(): Promise<string>
  createAction(args: CreateActionArgs): Promise<CreateActionResult>
  signLogin(message: string): Promise<{ sig: string; pubKey: string }>
}

const allowDemo = import.meta.env.VITE_ALLOW_DEMO_WALLET === 'true'

class YoursBrc100Wallet implements Brc100Wallet {
  isAvailable(): boolean {
    return getWalletStatus() === 'connected' && Boolean(getActiveContext())
  }

  async getIdentityKey(): Promise<string> {
    if (!this.isAvailable()) {
      throw new Error('Connect Yours Wallet first.')
    }
    const id = getIdentityKey()
    if (id) return id
    throw new Error('Yours Wallet did not return an identity key.')
  }

  async createAction(args: CreateActionArgs): Promise<CreateActionResult> {
    return createActionWithYours(args)
  }

  async signLogin(message: string): Promise<{ sig: string; pubKey: string }> {
    return signLoginMessage(message)
  }
}

/** Demo wallet: does not broadcast; returns a fake txid for local UX. */
class DemoWallet implements Brc100Wallet {
  isAvailable(): boolean {
    return true
  }

  async getIdentityKey(): Promise<string> {
    return 'demo-identity-key'
  }

  async createAction(args: CreateActionArgs): Promise<CreateActionResult> {
    console.info('[demo wallet] createAction', args)
    const fake =
      'demo' +
      Array.from(crypto.getRandomValues(new Uint8Array(28)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    return { txid: fake.slice(0, 64) }
  }

  async signLogin(message: string): Promise<{ sig: string; pubKey: string }> {
    const data = new TextEncoder().encode(`${message}:demo-identity-key`)
    const hash = await crypto.subtle.digest('SHA-256', data)
    const sig = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    return { sig, pubKey: 'demo-identity-key' }
  }
}

export function getWallet(): Brc100Wallet {
  const yours = new YoursBrc100Wallet()
  if (yours.isAvailable()) return yours
  if (allowDemo) return new DemoWallet()
  return yours
}

export function walletMode(): WalletStatus | 'demo' {
  if (allowDemo && getWalletStatus() !== 'connected') return 'demo'
  return getWalletStatus()
}

export async function ensureYoursConnected(): Promise<Brc100Wallet> {
  const yours = new YoursBrc100Wallet()
  if (yours.isAvailable()) return yours
  if (getWalletStatus() === 'missing') {
    throw new Error('Install Yours Wallet from yours.org, then refresh this page.')
  }
  await connectYours()
  if (!yours.isAvailable()) {
    throw new Error('Connect Yours Wallet to continue.')
  }
  return yours
}
