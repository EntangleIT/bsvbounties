/**
 * Deploy BountyEscrow to BSV testnet (or mainnet if NETWORK=main).
 *
 *   export BSV_TESTNET_WIF=...
 *   export NETWORK=test
 *   npm run testnet:deploy-demo -w @ai-bounties/contracts
 */
import { createHash, randomBytes } from 'node:crypto'
import { createBountyEscrowInstance } from '../scryptRuntime.js'
import { EscrowState, type EscrowSnapshot } from '../escrowState.js'
import { createTestSigner, fundInfo, wocExplorerTx } from './wallet.js'
import { networkName } from './config.js'

async function main() {
  console.log('Network:', networkName())
  const info = await fundInfo()
  console.log('Wallet:', JSON.stringify(info, null, 2))

  if ('error' in info) process.exit(1)
  if (info.balance && info.balance.confirmed + info.balance.unconfirmed < 2000) {
    console.error('Insufficient balance. Fund address via faucet:')
    console.error(info.faucet)
    process.exit(1)
  }

  const { signer, privateKey } = await createTestSigner()
  const pub = privateKey.publicKey.toString()

  const bountyId = randomBytes(16).toString('hex')
  const contentHash = createHash('sha256')
    .update('ai-bounties testnet demo')
    .digest('hex')

  const snapshot: EscrowSnapshot = {
    state: EscrowState.OPEN,
    amountSats: 1000,
    bountyId,
    contentHash,
    posterPubKey: pub,
    workerPubKey: '',
    arbiterPubKey: '',
    deadline: 0,
    workHash: '',
    feeBps: 0,
    feePkh: '',
  }

  const { instance } = createBountyEscrowInstance(snapshot)
  await instance.connect(signer)

  console.log('Deploying BountyEscrow with', snapshot.amountSats, 'sats…')
  const deployTx = await instance.deploy(snapshot.amountSats)
  const txid = deployTx.id
  console.log('Deployed txid:', txid)
  console.log('Explorer:', wocExplorerTx(txid))
  console.log('bountyId:', bountyId)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
