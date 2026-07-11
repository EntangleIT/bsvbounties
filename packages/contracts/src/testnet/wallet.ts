/**
 * scrypt-ts TestWallet + DefaultProvider for testnet/mainnet.
 */
import { createRequire } from 'node:module'
import {
  isTestnet,
  networkName,
  testnetPrivateKeyWif,
  wocExplorerTx,
} from './config.js'
import { getAddressBalance } from './woc.js'

const require = createRequire(import.meta.url)

export function getScryptNetwork() {
  const { bsv } = require('scrypt-ts') as typeof import('scrypt-ts')
  return isTestnet() ? bsv.Networks.testnet : bsv.Networks.mainnet
}

export function getPrivateKey() {
  const { bsv } = require('scrypt-ts') as typeof import('scrypt-ts')
  const wif = testnetPrivateKeyWif()
  if (!wif) {
    throw new Error(
      'Set BSV_TESTNET_WIF (WIF private key) to deploy/call on testnet. Fund via https://scrypt.io/faucet',
    )
  }
  return bsv.PrivateKey.fromWIF(wif)
}

export function getAddress(): string {
  const pk = getPrivateKey()
  return pk.toAddress(getScryptNetwork()).toString()
}

export async function createTestSigner() {
  const { DefaultProvider, TestWallet, bsv } = require('scrypt-ts') as typeof import('scrypt-ts')
  const privateKey = getPrivateKey()
  const network = isTestnet() ? bsv.Networks.testnet : bsv.Networks.mainnet
  // DefaultProviderOption accepts network name or options object depending on scrypt-ts version
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provider = new (DefaultProvider as any)(network)
  const signer = new TestWallet(privateKey, provider)
  return { signer, privateKey, provider, network, address: getAddress() }
}

export async function fundInfo() {
  const network = networkName()
  try {
    const address = getAddress()
    const bal = await getAddressBalance(address)
    return {
      network,
      address,
      balance: bal,
      faucet: isTestnet()
        ? [
            'https://scrypt.io/faucet',
            'https://witnessonchain.com/faucet/tbsv',
            'https://testnet.help/en/bsvfaucet/testnet',
          ]
        : [],
      explorer: isTestnet()
        ? `https://test.whatsonchain.com/address/${address}`
        : `https://whatsonchain.com/address/${address}`,
    }
  } catch (e) {
    return {
      network,
      error: e instanceof Error ? e.message : String(e),
      faucet: [
        'https://scrypt.io/faucet',
        'https://witnessonchain.com/faucet/tbsv',
      ],
    }
  }
}

export { wocExplorerTx }
