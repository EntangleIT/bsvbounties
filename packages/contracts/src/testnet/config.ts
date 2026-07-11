export type BsvNetworkName = 'main' | 'test'

export function networkName(): BsvNetworkName {
  const n = (process.env.NETWORK ?? process.env.BSV_NETWORK ?? 'test').toLowerCase()
  return n === 'main' || n === 'mainnet' ? 'main' : 'test'
}

export function isTestnet(): boolean {
  return networkName() === 'test'
}

/** WhatsOnChain API base (no trailing slash). */
export function wocApiBase(): string {
  return isTestnet()
    ? 'https://api.whatsonchain.com/v1/bsv/test'
    : 'https://api.whatsonchain.com/v1/bsv/main'
}

export function wocExplorerTx(txid: string): string {
  return isTestnet()
    ? `https://test.whatsonchain.com/tx/${txid}`
    : `https://whatsonchain.com/tx/${txid}`
}

/**
 * Testnet private key (WIF). Required for server-side deploy demos.
 * Never commit a real key. Fund via https://scrypt.io/faucet
 */
export function testnetPrivateKeyWif(): string | undefined {
  return process.env.BSV_TESTNET_WIF || process.env.TESTNET_PRIVATE_KEY
}

export function escrowMode(): 'app' | 'scrypt' {
  const m = (process.env.ESCROW_MODE ?? 'app').toLowerCase()
  return m === 'scrypt' ? 'scrypt' : 'app'
}
