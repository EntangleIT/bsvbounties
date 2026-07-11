/**
 * Load compiled BountyEscrow artifact and construct instances for deploy/call.
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EscrowSnapshot } from './escrowState.js'
import { EscrowState } from './escrowState.js'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

function findFile(names: string[]): string {
  const bases = [
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '../..'),
    path.resolve(process.cwd()),
    path.resolve(process.cwd(), 'packages/contracts'),
  ]
  for (const base of bases) {
    for (const name of names) {
      const p = path.join(base, name)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error(`Not found: ${names.join(' or ')}`)
}

export function getArtifactPath(): string {
  return findFile([
    'artifacts/bountyEscrow.json',
    'dist/../artifacts/bountyEscrow.json',
  ])
}

export function isScryptArtifactAvailable(): boolean {
  try {
    getArtifactPath()
    return true
  } catch {
    return false
  }
}

let loaded = false
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let BountyEscrowClass: any

function loadClass() {
  if (BountyEscrowClass) return BountyEscrowClass
  const classPath = findFile([
    'dist/contracts-cjs/bountyEscrow.js',
    'contracts-cjs/bountyEscrow.js',
  ])
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  BountyEscrowClass = require(classPath).BountyEscrow
  return BountyEscrowClass
}

export function loadBountyEscrowArtifact(): void {
  if (loaded) return
  const Cls = loadClass()
  const artifact = getArtifactPath()
  Cls.loadArtifact(artifact)
  loaded = true
}

function scryptTs() {
  return require('scrypt-ts') as typeof import('scrypt-ts')
}

function toPubKey(hex: string) {
  const { PubKey, toByteString } = scryptTs()
  const clean = (hex.startsWith('0x') ? hex.slice(2) : hex) || ''
  if (clean.length < 66) {
    return PubKey(toByteString('00'.repeat(33)))
  }
  return PubKey(toByteString(clean))
}

function toBytes(hex: string, padBytes?: number) {
  const { toByteString } = scryptTs()
  let clean = (hex.startsWith('0x') ? hex.slice(2) : hex) || ''
  if (padBytes != null) {
    clean = clean.padEnd(padBytes * 2, '0').slice(0, padBytes * 2)
  }
  return toByteString(clean)
}

export function createBountyEscrowInstance(snapshot: EscrowSnapshot) {
  loadBountyEscrowArtifact()
  const Cls = loadClass()

  const workerHex =
    snapshot.workerPubKey && snapshot.workerPubKey.length >= 66
      ? snapshot.workerPubKey
      : '00'.repeat(33)
  const workHex =
    snapshot.workHash && snapshot.workHash.length >= 64
      ? snapshot.workHash
      : '00'.repeat(32)
  const arbiterHex =
    snapshot.arbiterPubKey && snapshot.arbiterPubKey.length >= 66
      ? snapshot.arbiterPubKey
      : '00'.repeat(33)

  const instance = new Cls(
    toPubKey(snapshot.posterPubKey),
    toPubKey(workerHex),
    toPubKey(arbiterHex),
    BigInt(snapshot.amountSats),
    BigInt(snapshot.deadline),
    toBytes(workHex, 32),
    BigInt(snapshot.state),
    toBytes(snapshot.bountyId, 16),
    toBytes(snapshot.contentHash, 32),
    BigInt(snapshot.feeBps),
    toBytes(snapshot.feePkh || ''),
  )

  return { instance, Cls }
}

export function lockingScriptHexFromInstance(instance: {
  lockingScript: { toHex: () => string }
}): string {
  return instance.lockingScript.toHex()
}

export function toContractState(s: EscrowState): bigint {
  return BigInt(s)
}

export function getArtifactMeta(): {
  contract: string
  compilerVersion?: string
  md5?: string
  path: string
} {
  const p = getArtifactPath()
  const j = JSON.parse(fs.readFileSync(p, 'utf8')) as {
    contract: string
    compilerVersion?: string
    md5?: string
  }
  return {
    contract: j.contract,
    compilerVersion: j.compilerVersion,
    md5: j.md5,
    path: p,
  }
}
