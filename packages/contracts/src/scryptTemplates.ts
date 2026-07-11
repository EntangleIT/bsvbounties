/**
 * When ESCROW_MODE=scrypt, produce createAction outputs using the compiled
 * BountyEscrow locking script (from artifact) instead of P2PKH hold.
 */
import {
  BRC100_LABELS,
  buildBountyPostLockingScript,
  categoryFromLabel,
  type BountyCategory,
} from '@ai-bounties/shared'
import type { EscrowSnapshot } from './escrowState.js'
import { stateName } from './escrowState.js'
import type { CreateActionTemplate } from './templates.js'
import { buildEscrowParamScript } from './templates.js'
import {
  createBountyEscrowInstance,
  isScryptArtifactAvailable,
  lockingScriptHexFromInstance,
} from './scryptRuntime.js'

export function canUseScryptEscrow(): boolean {
  return isScryptArtifactAvailable()
}

/**
 * Deploy template using compiled covenant locking script as the value output.
 */
export function buildScryptDeployTemplate(opts: {
  snapshot: EscrowSnapshot
  title: string
  category: string
}): CreateActionTemplate {
  if (!isScryptArtifactAvailable()) {
    throw new Error('scrypt artifact missing — run npm run compile -w @ai-bounties/contracts')
  }
  const { instance } = createBountyEscrowInstance(opts.snapshot)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lock = lockingScriptHexFromInstance(instance as any)

  return {
    description: `Deploy sCrypt BountyEscrow: ${opts.title}`,
    labels: [BRC100_LABELS.app, BRC100_LABELS.post, 'escrow:deploy', 'escrow:scrypt'],
    outputs: [
      {
        satoshis: opts.snapshot.amountSats,
        lockingScript: lock,
        outputDescription: `BountyEscrow (${stateName(opts.snapshot.state)})`,
      },
      {
        satoshis: 0,
        lockingScript: buildEscrowParamScript(opts.snapshot),
        outputDescription: 'Escrow state mirror (indexer)',
      },
      {
        satoshis: 0,
        lockingScript: buildBountyPostLockingScript({
          bountyId: opts.snapshot.bountyId,
          amountSats: opts.snapshot.amountSats,
          contentHash: opts.snapshot.contentHash,
          category: categoryFromLabel(opts.category) as BountyCategory,
          title: opts.title,
        }),
        outputDescription: 'BOUNTY_POST protocol data',
      },
    ],
  }
}
