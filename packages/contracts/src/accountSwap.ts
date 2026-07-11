import { LockingScript } from '@bsv/sdk'
import {
  AccountAction,
  BRC100_LABELS,
  encodeAccountTransferPayload,
  encodeProtocolMessage,
  sha256Hex,
} from '@ai-bounties/shared'
import type { CreateActionTemplate } from './templates.js'
import { p2pkhFromPubKeyHex } from './templates.js'

/**
 * Atomic account sale template (Phase 4).
 *
 * One createAction that:
 *  1. Pays the seller `priceSats` (P2PKH to seller)
 *  2. Moves the 1-sat account token to the buyer (P2PKH to buyer)
 *  3. Records ACCOUNT_TRANSFER in OP_RETURN
 *
 * Wallet must include the seller's account 1-sat UTXO as an input
 * (BRC-100: seller co-signs or pre-authorizes). Demo wallets fake the txid.
 */
export function buildAtomicAccountSwapTemplate(opts: {
  accountNumber: number
  priceSats: number
  sellerControllerKey: string
  buyerControllerKey: string
  /** Optional explicit locking scripts (else derived from controller keys). */
  sellerPaymentLockingScriptHex?: string
  buyerAccountLockingScriptHex?: string
}): CreateActionTemplate {
  const sellerPay =
    opts.sellerPaymentLockingScriptHex ??
    p2pkhFromPubKeyHex(opts.sellerControllerKey)
  const buyerHold =
    opts.buyerAccountLockingScriptHex ??
    p2pkhFromPubKeyHex(opts.buyerControllerKey)

  const transferPayload = encodeAccountTransferPayload({
    accountNumber: opts.accountNumber,
    toControllerKeyHash: sha256Hex(opts.buyerControllerKey),
    priceSats: opts.priceSats,
  })
  const body = encodeProtocolMessage(AccountAction.TRANSFER, transferPayload)
  const opreturn = LockingScript.fromASM(
    `OP_FALSE OP_RETURN ${bytesToHex(body)}`,
  ).toHex()

  return {
    description: `Atomic swap AI Bounties account #${opts.accountNumber} for ${opts.priceSats} sats`,
    labels: [
      BRC100_LABELS.app,
      BRC100_LABELS.accountTransfer,
      'account:atomic-swap',
    ],
    outputs: [
      {
        satoshis: opts.priceSats,
        lockingScript: sellerPay,
        outputDescription: `Payment to seller of #${opts.accountNumber}`,
      },
      {
        satoshis: 1,
        lockingScript: buyerHold,
        outputDescription: `Account #${opts.accountNumber} token → buyer`,
      },
      {
        satoshis: 0,
        lockingScript: opreturn,
        outputDescription: 'ACCOUNT_TRANSFER protocol data',
      },
    ],
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Poster bond deposit template: lock bond sats to platform/poster hold + OP_RETURN.
 */
export function buildBondDepositTemplate(opts: {
  amountSats: number
  controllerKey: string
  /** Platform bond vault locking script; defaults to hash of controller (self-bond demo). */
  vaultLockingScriptHex?: string
}): CreateActionTemplate {
  const vault =
    opts.vaultLockingScriptHex ?? p2pkhFromPubKeyHex(opts.controllerKey)
  const note = new TextEncoder().encode(
    `aibounties-bond:${opts.controllerKey.slice(0, 32)}`,
  )
  const opreturn = LockingScript.fromASM(
    `OP_FALSE OP_RETURN ${bytesToHex(note)}`,
  ).toHex()

  return {
    description: `Deposit poster bond ${opts.amountSats} sats`,
    labels: [BRC100_LABELS.app, 'bond:deposit'],
    outputs: [
      {
        satoshis: opts.amountSats,
        lockingScript: vault,
        outputDescription: 'Poster bond vault',
      },
      {
        satoshis: 0,
        lockingScript: opreturn,
        outputDescription: 'Bond deposit record',
      },
    ],
  }
}
