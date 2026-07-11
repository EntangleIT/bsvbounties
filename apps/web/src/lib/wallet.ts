/**
 * BRC-100 wallet client (Metanet Client, Yours, bsv-wallet-cli, etc.)
 *
 * Phase 1: thin wrapper around window.bitcoin / MetaNet-style interfaces.
 * When no wallet is present, runs in "demo mode" (API index only).
 */

export interface CreateActionOutput {
  satoshis: number
  lockingScript: string
  outputDescription?: string
}

export interface CreateActionArgs {
  description: string
  labels?: string[]
  outputs: CreateActionOutput[]
}

export interface CreateActionResult {
  txid?: string
  tx?: unknown
  rawTx?: string
}

export interface Brc100Wallet {
  isAvailable(): boolean
  getIdentityKey?(): Promise<string | undefined>
  createAction(args: CreateActionArgs): Promise<CreateActionResult>
}

declare global {
  interface Window {
    bitcoin?: {
      isReady?: boolean
      createAction?: (args: CreateActionArgs) => Promise<CreateActionResult>
      getPublicKey?: () => Promise<{ publicKey?: string } | string>
      getIdentityKey?: () => Promise<string>
    }
    yours?: {
      isReady?: boolean
      request?: (method: string, params?: unknown) => Promise<unknown>
    }
  }
}

class BrowserBrc100Wallet implements Brc100Wallet {
  isAvailable(): boolean {
    return Boolean(window.bitcoin?.createAction)
  }

  async getIdentityKey(): Promise<string | undefined> {
    if (window.bitcoin?.getIdentityKey) {
      return window.bitcoin.getIdentityKey()
    }
    if (window.bitcoin?.getPublicKey) {
      const r = await window.bitcoin.getPublicKey()
      return typeof r === 'string' ? r : r?.publicKey
    }
    return undefined
  }

  async createAction(args: CreateActionArgs): Promise<CreateActionResult> {
    if (!window.bitcoin?.createAction) {
      throw new Error(
        'No BRC-100 wallet detected. Install Metanet Client or Yours Wallet.',
      )
    }
    return window.bitcoin.createAction(args)
  }
}

/** Demo wallet: does not broadcast; returns a fake txid for local UX. */
class DemoWallet implements Brc100Wallet {
  isAvailable(): boolean {
    return true
  }

  async getIdentityKey(): Promise<string | undefined> {
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
}

let cached: Brc100Wallet | null = null

export function getWallet(preferDemo = false): Brc100Wallet {
  if (preferDemo) return new DemoWallet()
  if (!cached) {
    const real = new BrowserBrc100Wallet()
    cached = real.isAvailable() ? real : new DemoWallet()
  }
  return cached
}

export function walletMode(): 'brc100' | 'demo' {
  return new BrowserBrc100Wallet().isAvailable() ? 'brc100' : 'demo'
}
