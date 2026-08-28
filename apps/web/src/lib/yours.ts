/**
 * Yours Wallet (BRC-100) — same stack SatPress uses on entangleit.com.
 * Docs: https://yours-wallet.gitbook.io/provider-api
 */
import {
  createContext,
  signBsm,
  type OneSatContext,
} from '@1sat/actions'
import { OneSatServices } from '@1sat/client'

export const YOURS_CHROME =
  'https://chromewebstore.google.com/detail/yours-wallet/mlbnicldlpdimbjdcncnklfempedeipj'
export const YOURS_SITE = 'https://yours.org'
export const WOC_TX = 'https://whatsonchain.com/tx'

/** Must stay stable — it fixes the derived BSM key Yours signs login with. */
export const LOGIN_SIGN_TAG = {
  label: 'ai-bounties',
  id: 'login',
  domain: 'entangleit.com',
  meta: {},
}

const services = new OneSatServices('main')

let activeCtx: OneSatContext | null = null
let identityKey: string | null = null
let connectFn: (() => Promise<void>) | null = null

export type WalletStatus =
  | 'detecting'
  | 'missing'
  | 'available'
  | 'connecting'
  | 'connected'

let status: WalletStatus = 'detecting'
const listeners = new Set<() => void>()

function emit() {
  for (const fn of listeners) fn()
}

export function subscribeWallet(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getWalletStatus(): WalletStatus {
  return status
}

export function getIdentityKey(): string | null {
  return identityKey
}

export function getActiveContext(): OneSatContext | null {
  return activeCtx
}

export function requireContext(): OneSatContext {
  if (!activeCtx) {
    throw new Error('Connect Yours Wallet first.')
  }
  return activeCtx
}

export function registerConnect(fn: () => Promise<void>) {
  connectFn = fn
}

export async function connectYours(): Promise<void> {
  if (!connectFn) {
    throw new Error('Yours Wallet is not ready yet. Refresh and try again.')
  }
  await connectFn()
}

export function buildContext(wallet: NonNullable<OneSatContext['wallet']>): OneSatContext {
  return createContext(wallet, { chain: 'main', services, isBaseWallet: false })
}

export function syncFromProvider(input: {
  status: 'disconnected' | 'detecting' | 'selecting' | 'connecting' | 'connected'
  wallet: OneSatContext['wallet'] | null
  identityKey: string | null
  hasProviders: boolean
}) {
  if (input.status === 'connected' && input.wallet) {
    activeCtx = buildContext(input.wallet)
    identityKey = input.identityKey
    status = 'connected'
  } else {
    activeCtx = null
    identityKey = null
    if (input.status === 'connecting' || input.status === 'selecting') {
      status = 'connecting'
    } else if (input.status === 'detecting') {
      status = status === 'connected' ? 'available' : 'detecting'
    } else {
      // Idle `disconnected` means "not connected yet", not "extension missing".
      // @1sat/connect auto-detects Yours via CWI; window.yours is legacy.
      status = 'available'
    }
  }
  emit()
}

const WALLET_CALL_TIMEOUT_MS = 180_000

class WalletTimeoutError extends Error {
  constructor(readonly stage: string) {
    super(`wallet-timeout:${stage}`)
    this.name = 'WalletTimeoutError'
  }
}

function withTimeout<T>(p: Promise<T>, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new WalletTimeoutError(stage)),
      WALLET_CALL_TIMEOUT_MS,
    )
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

async function recoverTimedOutTxid(descriptionPrefix: string): Promise<string | null> {
  try {
    const wallet = activeCtx?.wallet
    if (!wallet?.listActions) return null
    const { actions } = await wallet.listActions({ labels: [], limit: 10 })
    const match = (actions ?? []).find(
      (a) =>
        a.isOutgoing &&
        typeof a.description === 'string' &&
        a.description.startsWith(descriptionPrefix) &&
        (a.status === 'completed' || a.status === 'unproven') &&
        a.txid,
    )
    return match?.txid ? String(match.txid).toLowerCase() : null
  } catch {
    return null
  }
}

export type CreateActionArgs = {
  description: string
  labels?: string[]
  outputs: Array<{
    satoshis: number
    lockingScript: string
    outputDescription?: string
    basket?: string
  }>
  options?: {
    acceptDelayedBroadcast?: boolean
    randomizeOutputs?: boolean
  }
}

export type CreateActionResult = {
  txid?: string
  tx?: unknown
  rawTx?: string
}

export async function createActionWithYours(
  args: CreateActionArgs,
): Promise<CreateActionResult> {
  const ctx = requireContext()
  const prefix = args.description.slice(0, 48)
  try {
    const result = (await withTimeout(
      ctx.wallet.createAction({
        description: args.description,
        labels: args.labels,
        outputs: args.outputs.map((o) => ({
          satoshis: o.satoshis,
          lockingScript: o.lockingScript,
          outputDescription: o.outputDescription ?? 'output',
          ...(o.basket ? { basket: o.basket } : {}),
        })),
        options: {
          acceptDelayedBroadcast: false,
          randomizeOutputs: false,
          ...args.options,
        },
      }),
      'createAction',
    )) as CreateActionResult
    if (result.txid) return { txid: String(result.txid).toLowerCase() }
    throw new Error('Yours Wallet did not return a txid.')
  } catch (err) {
    if (err instanceof WalletTimeoutError) {
      const recovered = await recoverTimedOutTxid(prefix)
      if (recovered) return { txid: recovered }
      throw new Error(
        'Yours Wallet did not finish within 3 minutes. Check the extension activity — the transaction may already have broadcast.',
      )
    }
    throw wrapWalletError(err, 'Transaction')
  }
}

export async function signLoginMessage(message: string): Promise<{
  sig: string
  pubKey: string
}> {
  const ctx = requireContext()
  const signed = await signBsm.execute(ctx, {
    message,
    encoding: 'utf8',
    tag: LOGIN_SIGN_TAG,
  })
  if (signed.error) throw wrapWalletError(new Error(signed.error), 'Sign-in')
  if (!signed.sig || !signed.pubKey) {
    throw new Error('Yours Wallet did not return a signature.')
  }
  return { sig: signed.sig, pubKey: signed.pubKey }
}

export function wrapWalletError(err: unknown, verb: string): Error {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error')
  const lower = raw.toLowerCase()
  if (
    lower.includes('user-rejected') ||
    lower.includes('reject') ||
    lower.includes('denied') ||
    lower.includes('cancel') ||
    lower.includes('closed')
  ) {
    return new Error(`${verb} was rejected in Yours Wallet.`)
  }
  if (
    lower.includes('insufficient-funds') ||
    lower.includes('insufficient') ||
    lower.includes('not enough')
  ) {
    return new Error('Yours Wallet does not have enough BSV to broadcast this.')
  }
  if (lower.includes('storage-payment-failed') || lower.includes('storage')) {
    return new Error('Yours Wallet remote storage needs a top-up before broadcasting.')
  }
  if (
    lower.includes('not-connected') ||
    lower.includes('connect') ||
    lower.includes('locked')
  ) {
    return new Error('Unlock Yours Wallet and connect it to AI Bounties.')
  }
  return new Error(raw || `${verb} failed in Yours Wallet.`)
}

export function whatsonchainUrl(txid: string): string {
  return `${WOC_TX}/${txid.replace(/_.*/, '')}`
}
