/**
 * BountyEscrow — sCrypt stateful covenant for AI Bounties.
 *
 * Compile: npm run compile -w @ai-bounties/contracts
 * Artifact: artifacts/bountyEscrow.json
 */
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
  len,
  toByteString,
  Addr,
} from 'scrypt-ts'

export const ESCROW_OPEN = 0n
export const ESCROW_CLAIMED = 1n
export const ESCROW_SUBMITTED = 2n

/**
 * Stateful bounty escrow UTXO.
 *
 * Note: property cannot be named `state` (reserved in sCrypt).
 */
export class BountyEscrow extends SmartContract {
  @prop()
  readonly poster: PubKey

  @prop(true)
  worker: PubKey

  @prop()
  readonly arbiter: PubKey

  @prop()
  readonly amount: bigint

  @prop()
  readonly deadline: bigint

  @prop(true)
  workHash: ByteString

  /** 0=OPEN 1=CLAIMED 2=SUBMITTED */
  @prop(true)
  escrowState: bigint

  @prop()
  readonly bountyId: ByteString

  @prop()
  readonly contentHash: ByteString

  @prop()
  readonly feeBps: bigint

  /** 20-byte fee pkh, or empty ByteString */
  @prop()
  readonly feePkh: ByteString

  constructor(
    poster: PubKey,
    worker: PubKey,
    arbiter: PubKey,
    amount: bigint,
    deadline: bigint,
    workHash: ByteString,
    escrowState: bigint,
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
    this.escrowState = escrowState
    this.bountyId = bountyId
    this.contentHash = contentHash
    this.feeBps = feeBps
    this.feePkh = feePkh
  }

  @method(SigHash.ANYONECANPAY_SINGLE)
  public claim(sig: Sig, workerPk: PubKey) {
    assert(this.escrowState === ESCROW_OPEN, 'not open')
    assert(this.checkSig(sig, workerPk), 'bad worker sig')
    assert(hash256(workerPk) != hash256(this.poster), 'poster cannot claim')

    this.worker = workerPk
    this.escrowState = ESCROW_CLAIMED

    const output: ByteString = this.buildStateOutput(this.amount)
    assert(this.ctx.hashOutputs == hash256(output), 'hashOutputs mismatch')
  }

  @method(SigHash.ANYONECANPAY_SINGLE)
  public submit(sig: Sig, wh: ByteString) {
    assert(
      this.escrowState === ESCROW_CLAIMED ||
        this.escrowState === ESCROW_SUBMITTED,
      'not claimed',
    )
    assert(this.checkSig(sig, this.worker), 'worker only')
    assert(len(wh) === 32n, 'work hash must be 32 bytes')

    this.workHash = wh
    this.escrowState = ESCROW_SUBMITTED

    const output: ByteString = this.buildStateOutput(this.amount)
    assert(this.ctx.hashOutputs == hash256(output), 'hashOutputs mismatch')
  }

  @method()
  public approve(sig: Sig) {
    assert(
      this.escrowState === ESCROW_CLAIMED ||
        this.escrowState === ESCROW_SUBMITTED,
      'not active',
    )
    assert(this.checkSig(sig, this.poster), 'poster only')

    const fee: bigint = (this.amount * this.feeBps) / 10000n
    const toWorker: bigint = this.amount - fee
    const workerOut: ByteString = Utils.buildPublicKeyHashOutput(
      pubKey2Addr(this.worker),
      toWorker,
    )
    const outputs: ByteString = this.appendFeeAndChange(workerOut, fee)
    assert(this.ctx.hashOutputs == hash256(outputs), 'hashOutputs mismatch')
  }

  @method()
  public cancel(sig: Sig) {
    assert(this.escrowState === ESCROW_OPEN, 'not open')
    assert(this.checkSig(sig, this.poster), 'poster only')

    const posterOut: ByteString = Utils.buildPublicKeyHashOutput(
      pubKey2Addr(this.poster),
      this.amount,
    )
    const outputs: ByteString = posterOut + this.buildChangeOutput()
    assert(this.ctx.hashOutputs == hash256(outputs), 'hashOutputs mismatch')
  }

  @method()
  public refund(sig: Sig) {
    assert(
      this.escrowState === ESCROW_CLAIMED ||
        this.escrowState === ESCROW_SUBMITTED,
      'not active',
    )
    assert(this.checkSig(sig, this.poster), 'poster only')
    assert(this.deadline > 0n, 'no deadline')
    assert(this.ctx.locktime >= this.deadline, 'too early')

    const posterOut: ByteString = Utils.buildPublicKeyHashOutput(
      pubKey2Addr(this.poster),
      this.amount,
    )
    const outputs: ByteString = posterOut + this.buildChangeOutput()
    assert(this.ctx.hashOutputs == hash256(outputs), 'hashOutputs mismatch')
  }

  @method()
  public resolvePayWorker(sig: Sig) {
    assert(
      this.escrowState === ESCROW_CLAIMED ||
        this.escrowState === ESCROW_SUBMITTED,
      'not active',
    )
    assert(len(this.arbiter) === 33n, 'no arbiter')
    assert(this.checkSig(sig, this.arbiter), 'arbiter only')

    const fee: bigint = (this.amount * this.feeBps) / 10000n
    const toWorker: bigint = this.amount - fee
    const workerOut: ByteString = Utils.buildPublicKeyHashOutput(
      pubKey2Addr(this.worker),
      toWorker,
    )
    const outputs: ByteString = this.appendFeeAndChange(workerOut, fee)
    assert(this.ctx.hashOutputs == hash256(outputs), 'hashOutputs mismatch')
  }

  @method()
  public resolveRefundPoster(sig: Sig) {
    assert(
      this.escrowState === ESCROW_CLAIMED ||
        this.escrowState === ESCROW_SUBMITTED,
      'not active',
    )
    assert(len(this.arbiter) === 33n, 'no arbiter')
    assert(this.checkSig(sig, this.arbiter), 'arbiter only')

    const posterOut: ByteString = Utils.buildPublicKeyHashOutput(
      pubKey2Addr(this.poster),
      this.amount,
    )
    const outputs: ByteString = posterOut + this.buildChangeOutput()
    assert(this.ctx.hashOutputs == hash256(outputs), 'hashOutputs mismatch')
  }

  @method()
  private appendFeeAndChange(base: ByteString, fee: bigint): ByteString {
    let outs: ByteString = base
    if (fee > 0n && len(this.feePkh) === 20n) {
      outs += Utils.buildPublicKeyHashOutput(Addr(this.feePkh), fee)
    }
    outs += this.buildChangeOutput()
    return outs
  }
}

/** Empty worker placeholder until claim (33 zero bytes as hex). */
export function emptyWorkerPubKeyHex(): string {
  return '00'.repeat(33)
}

export function emptyWorkHashHex(): string {
  return '00'.repeat(32)
}
