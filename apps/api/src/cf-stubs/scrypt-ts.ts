/**
 * Minimal scrypt-ts stand-in so the Worker bundle does not pull the Node compiler.
 * On-chain escrow stays on the Node API (`ESCROW_MODE=scrypt`); Cloudflare runs app escrow.
 */
export const bsv = {
  Networks: { testnet: { name: 'testnet' }, mainnet: { name: 'livenet' } },
  PrivateKey: {
    fromWIF() {
      throw new Error('scrypt-ts is not available in the Cloudflare Worker')
    },
  },
}

export class DefaultProvider {
  constructor(_network?: unknown) {}
}

export class TestWallet {
  constructor(_key?: unknown, _provider?: unknown) {}
}

export function PubKey(value: string) {
  return value
}

export function toByteString(value: string) {
  return value
}
