/**
 * BountyEscrow — sCrypt-style contract source for AI Bounties (Phase 3).
 *
 * This file is written in scrypt-ts idiomatic TypeScript so it can be compiled
 * with the sCrypt toolchain (`scrypt-ts` + scryptc) when you deploy mainnet
 * covenants. The runtime app uses `escrowState.ts` + `templates.ts` for the
 * same rules and BRC-100 createAction templates.
 *
 * Lifecycle (state UTXO):
 *   OPEN → claim → CLAIMED → submit → SUBMITTED
 *        ↘ cancel (poster)
 *   CLAIMED|SUBMITTED → approve (poster) → P2PKH worker (+ optional fee)
 *   CLAIMED|SUBMITTED → refund (poster, after deadline) → P2PKH poster
 *   CLAIMED|SUBMITTED → resolve (arbiter) → worker or poster
 *
 * Install to compile:
 *   npm i -D scrypt-ts
 *   npx scrypt-cli@latest compile   # or project-specific compile script
 */

/* eslint-disable @typescript-eslint/no-unused-vars */
// The following is documentation-grade scrypt-ts source.
// It is NOT executed by Node at runtime (see escrowState.ts).

/*
import {
  assert,
  ByteString,
  method,
  prop,
  SmartContract,
  PubKey,
  Sig,
  SigHash,
  hash256,
  Utils,
  pubKey2Addr,
  toByteString,
  len,
} from 'scrypt-ts'

export class BountyEscrow extends SmartContract {
  @prop() poster: PubKey
  @prop() worker: PubKey
  @prop() arbiter: PubKey
  @prop() amount: bigint
  @prop() deadline: bigint
  @prop() workHash: ByteString
  @prop() state: bigint // 0 OPEN, 1 CLAIMED, 2 SUBMITTED
  @prop() bountyId: ByteString
  @prop() contentHash: ByteString
  @prop() feeBps: bigint
  @prop() feePkh: ByteString // 20-byte pkh or empty

  constructor(
    poster: PubKey,
    worker: PubKey,
    arbiter: PubKey,
    amount: bigint,
    deadline: bigint,
    workHash: ByteString,
    state: bigint,
    bountyId: ByteString,
    contentHash: ByteString,
    feeBps: bigint,
    feePkh: ByteString,
  ) {
    super(...arguments)
    this.poster = poster
    this.worker = worker
    this.arbiter = arbiter
    this.amount = amount
    this.deadline = deadline
    this.workHash = workHash
    this.state = state
    this.bountyId = bountyId
    this.contentHash = contentHash
    this.feeBps = feeBps
    this.feePkh = feePkh
  }

  @method(SigHash.ANYONECANPAY_SINGLE)
  public claim(sig: Sig, workerPk: PubKey) {
    assert(this.state === 0n, 'not open')
    assert(this.checkSig(sig, workerPk), 'bad worker sig')
    // propagate state with worker set
    this.worker = workerPk
    this.state = 1n
    const output = this.buildStateOutput(this.amount)
    assert(this.ctx.hashOutputs === hash256(output), 'hashOutputs')
  }

  @method(SigHash.ANYONECANPAY_SINGLE)
  public submit(sig: Sig, wh: ByteString) {
    assert(this.state === 1n || this.state === 2n, 'not claimed')
    assert(this.checkSig(sig, this.worker), 'worker only')
    assert(len(wh) === 32n, 'work hash 32 bytes')
    this.workHash = wh
    this.state = 2n
    const output = this.buildStateOutput(this.amount)
    assert(this.ctx.hashOutputs === hash256(output), 'hashOutputs')
  }

  @method()
  public approve(sig: Sig) {
    assert(this.state === 1n || this.state === 2n, 'not active')
    assert(this.checkSig(sig, this.poster), 'poster only')
    const fee = (this.amount * this.feeBps) / 10000n
    const toWorker = this.amount - fee
    let outputs = Utils.buildPublicKeyHashOutput(pubKey2Addr(this.worker), toWorker)
    if (fee > 0n && len(this.feePkh) === 20n) {
      outputs += Utils.buildPublicKeyHashOutput(this.feePkh, fee)
    }
    outputs += this.buildChangeOutput()
    assert(this.ctx.hashOutputs === hash256(outputs), 'hashOutputs')
  }

  @method()
  public cancel(sig: Sig) {
    assert(this.state === 0n, 'not open')
    assert(this.checkSig(sig, this.poster), 'poster only')
    const outputs =
      Utils.buildPublicKeyHashOutput(pubKey2Addr(this.poster), this.amount) +
      this.buildChangeOutput()
    assert(this.ctx.hashOutputs === hash256(outputs), 'hashOutputs')
  }

  @method()
  public refund(sig: Sig) {
    assert(this.state === 1n || this.state === 2n, 'not active')
    assert(this.checkSig(sig, this.poster), 'poster only')
    assert(this.deadline > 0n, 'no deadline')
    assert(this.ctx.locktime >= this.deadline, 'too early')
    const outputs =
      Utils.buildPublicKeyHashOutput(pubKey2Addr(this.poster), this.amount) +
      this.buildChangeOutput()
    assert(this.ctx.hashOutputs === hash256(outputs), 'hashOutputs')
  }

  @method()
  public resolve(sig: Sig, payWorker: boolean) {
    assert(this.state === 1n || this.state === 2n, 'not active')
    assert(len(this.arbiter) > 0n, 'no arbiter')
    assert(this.checkSig(sig, this.arbiter), 'arbiter only')
    let outputs: ByteString
    if (payWorker) {
      const fee = (this.amount * this.feeBps) / 10000n
      const toWorker = this.amount - fee
      outputs = Utils.buildPublicKeyHashOutput(pubKey2Addr(this.worker), toWorker)
      if (fee > 0n && len(this.feePkh) === 20n) {
        outputs += Utils.buildPublicKeyHashOutput(this.feePkh, fee)
      }
    } else {
      outputs = Utils.buildPublicKeyHashOutput(pubKey2Addr(this.poster), this.amount)
    }
    outputs += this.buildChangeOutput()
    assert(this.ctx.hashOutputs === hash256(outputs), 'hashOutputs')
  }
}
*/

/** Path to real scrypt-ts contract source (compile with npm run compile). */
export const BOUNTY_ESCROW_SCRYPT_SOURCE = 'src/contracts/bountyEscrow.ts'
export const BOUNTY_ESCROW_VERSION = 2
export const BOUNTY_ESCROW_ARTIFACT = 'artifacts/bountyEscrow.json'
