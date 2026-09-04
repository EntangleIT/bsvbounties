/**
 * RFC 3161 time-stamp client (ported from witnesscam `src/lib/rfc3161.ts`).
 *
 * Lets the marketplace obtain — and verify the binding of — independent
 * trusted-timestamp tokens over a work SHA-256. Only the hash leaves the
 * machine; the TSA learns nothing about the work itself.
 *
 * Isomorphic: global fetch + WebCrypto plus the workspace's existing
 * @noble/hashes hex helpers. No new dependencies.
 */

import { bytesToHex, hexToBytes } from './hash.js'

export interface DerNode {
  tag: number
  constructed: boolean
  bytes: Uint8Array
  children: DerNode[]
}

export function encodeLength(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n])
  if (n < 0x100) return new Uint8Array([0x81, n])
  if (n < 0x10000) return new Uint8Array([0x82, (n >> 8) & 0xff, n & 0xff])
  throw new Error('DER length too large')
}

export function encodeTlv(tag: number, content: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([tag]), encodeLength(content.length), content)
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function encodeIntegerBytes(value: Uint8Array): Uint8Array {
  let bytes = value
  while (bytes.length > 1 && bytes[0] === 0 && (bytes[1]! & 0x80) === 0) {
    bytes = bytes.slice(1)
  }
  if ((bytes[0]! & 0x80) !== 0) bytes = concatBytes(new Uint8Array([0]), bytes)
  return encodeTlv(0x02, bytes)
}

export function encodeInteger(n: number): Uint8Array {
  if (n < 0) throw new Error('negative INTEGER')
  if (n === 0) return encodeTlv(0x02, new Uint8Array([0]))
  const bytes: number[] = []
  let v = n
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v >>= 8
  }
  return encodeIntegerBytes(new Uint8Array(bytes))
}

export function encodeOid(oid: string): Uint8Array {
  const parts = oid.split('.').map((p) => Number(p))
  if (parts.length < 2) throw new Error('invalid OID')
  const body: number[] = [40 * parts[0]! + parts[1]!]
  for (const part of parts.slice(2)) {
    if (part < 0) throw new Error('invalid OID arc')
    const stack: number[] = []
    let n = part
    stack.push(n & 0x7f)
    n >>= 7
    while (n > 0) {
      stack.push(0x80 | (n & 0x7f))
      n >>= 7
    }
    for (let i = stack.length - 1; i >= 0; i--) body.push(stack[i]!)
  }
  return encodeTlv(0x06, new Uint8Array(body))
}

export function encodeOctetString(bytes: Uint8Array): Uint8Array {
  return encodeTlv(0x04, bytes)
}

export function encodeNull(): Uint8Array {
  return new Uint8Array([0x05, 0x00])
}

export function encodeBool(value: boolean): Uint8Array {
  return encodeTlv(0x01, new Uint8Array([value ? 0xff : 0x00]))
}

export function encodeSequence(...parts: Uint8Array[]): Uint8Array {
  return encodeTlv(0x30, concatBytes(...parts))
}

function readLength(
  data: Uint8Array,
  offset: number,
): { length: number; next: number } {
  if (offset >= data.length) throw new Error('truncated DER length')
  const first = data[offset]!
  if (first < 0x80) return { length: first, next: offset + 1 }
  const count = first & 0x7f
  if (count === 0 || count > 3) throw new Error('unsupported DER length')
  let length = 0
  for (let i = 0; i < count; i++) {
    length = (length << 8) | data[offset + 1 + i]!
  }
  return { length, next: offset + 1 + count }
}

export function parseDer(
  data: Uint8Array,
  offset = 0,
): { node: DerNode; next: number } {
  if (offset >= data.length) throw new Error('truncated DER')
  const tag = data[offset]!
  const constructed = (tag & 0x20) !== 0
  const len = readLength(data, offset + 1)
  const start = len.next
  const end = start + len.length
  if (end > data.length) throw new Error('truncated DER content')
  const bytes = data.slice(start, end)
  const children: DerNode[] = []
  if (constructed) {
    let i = 0
    while (i < bytes.length) {
      const inner = parseDer(bytes, i)
      children.push(inner.node)
      i = inner.next
    }
  }
  return {
    node: { tag: tag & 0x1f, constructed, bytes, children },
    next: end,
  }
}

export function parseDerRoot(data: Uint8Array): DerNode {
  return parseDer(data, 0).node
}

export function oidToString(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''
  const first = bytes[0]!
  const arcs = [Math.floor(first / 40), first % 40]
  let n = 0
  for (let i = 1; i < bytes.length; i++) {
    n = (n << 7) | (bytes[i]! & 0x7f)
    if ((bytes[i]! & 0x80) === 0) {
      arcs.push(n)
      n = 0
    }
  }
  return arcs.join('.')
}

export function integerToHex(bytes: Uint8Array): string {
  let start = 0
  if (bytes.length > 1 && bytes[0] === 0) start = 1
  return Array.from(bytes.slice(start), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

export function findOid(node: DerNode, oid: string): DerNode | null {
  if (node.tag === 0x06 && oidToString(node.bytes) === oid) return node
  for (const child of node.children) {
    const hit = findOid(child, oid)
    if (hit) return hit
  }
  return null
}

export function walk(node: DerNode, visit: (n: DerNode) => void): void {
  visit(node)
  for (const child of node.children) walk(child, visit)
}

// ---------------------------------------------------------------------------
// TimeStampReq / Resp
// ---------------------------------------------------------------------------

/** SHA-256 */
const OID_SHA256 = '2.16.840.1.101.3.4.2.1'
/** id-ct-TSTInfo */
const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4'

export interface TsaEndpoint {
  name: string
  url: string
}

export const TSA_ENDPOINTS: TsaEndpoint[] = [
  { name: 'DigiCert', url: 'http://timestamp.digicert.com' },
  { name: 'Sectigo', url: 'http://timestamp.sectigo.com' },
  { name: 'FreeTSA', url: 'https://freetsa.org/tsr' },
]

export interface Rfc3161Stamp {
  tsa: string
  tsaUrl: string
  /** Lowercase hex the TSA attests to (must equal the work hash). */
  hashedMessage: string
  /** ISO timestamp assigned by the TSA. */
  genTime: string
  /** Raw DER TimeStampResp, base64. Re-parseable offline. */
  tokenB64: string
  serial: string
  status: number
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

export function encodeTimeStampReq(
  sha256Hex: string,
  nonce: Uint8Array,
): Uint8Array {
  const hash = hexToBytes(sha256Hex)
  if (hash.length !== 32) {
    throw new Error('RFC 3161 hashedMessage must be SHA-256 (32 bytes)')
  }
  const alg = encodeSequence(encodeOid(OID_SHA256), encodeNull())
  const imprint = encodeSequence(alg, encodeOctetString(hash))
  return encodeSequence(
    encodeInteger(1),
    imprint,
    encodeIntegerBytes(nonce),
    encodeBool(true),
  )
}

export function parseAsn1Time(raw: string): string {
  const t = raw.trim()
  const gen = t.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z?$/i)
  if (gen) {
    const iso = `${gen[1]}-${gen[2]}-${gen[3]}T${gen[4]}:${gen[5]}:${gen[6]}Z`
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) throw new Error('invalid GeneralizedTime')
    return d.toISOString()
  }
  const utc = t.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z?$/i)
  if (utc) {
    const yy = Number(utc[1])
    const year = yy >= 50 ? 1900 + yy : 2000 + yy
    const iso = `${year}-${utc[2]}-${utc[3]}T${utc[4]}:${utc[5]}:${utc[6]}Z`
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) throw new Error('invalid UTCTime')
    return d.toISOString()
  }
  throw new Error('unrecognized ASN.1 time')
}

function textOf(node: DerNode): string {
  return new TextDecoder('ascii').decode(node.bytes)
}

function firstOctetStringAfter(node: DerNode, oid: string): Uint8Array | null {
  let seen = false
  let found: Uint8Array | null = null
  walk(node, (n) => {
    if (found) return
    if (n.tag === 0x06 && n.bytes && findOid(n, oid) === n) {
      seen = true
      return
    }
    if (seen && n.tag === 0x04 && n.bytes.length > 8) {
      found = n.bytes
    }
  })
  return found
}

export function parseTimeStampResp(
  der: Uint8Array,
  expectedHashHex: string,
): Omit<Rfc3161Stamp, 'tsa' | 'tsaUrl' | 'tokenB64'> {
  const root = parseDerRoot(der)
  const statusInfo = root.children[0]
  const statusNode = statusInfo?.children[0]
  const status = statusNode
    ? Number.parseInt(integerToHex(statusNode.bytes) || '0', 16)
    : 99
  if (status !== 0 && status !== 1) {
    throw new Error(`TSA rejected the request (PKIStatus ${status})`)
  }

  const tstInfoBytes = firstOctetStringAfter(root, OID_TST_INFO)
  if (!tstInfoBytes) throw new Error('TSA response did not include TSTInfo')
  const tstInfo = parseDerRoot(tstInfoBytes)
  const imprint = tstInfo.children[2]
  const hashed = imprint?.children[1]
  if (!hashed || hashed.tag !== 0x04) {
    throw new Error('TSTInfo missing hashedMessage')
  }
  const hashedMessage = bytesToHex(hashed.bytes)
  if (hashedMessage !== expectedHashHex.toLowerCase()) {
    throw new Error('TSA token hash does not match the work digest')
  }
  const serialNode = tstInfo.children[3]
  const serial = serialNode ? integerToHex(serialNode.bytes) : ''
  const timeNode = tstInfo.children[4]
  if (!timeNode || (timeNode.tag !== 0x17 && timeNode.tag !== 0x18)) {
    throw new Error('TSTInfo missing genTime')
  }
  const genTime = parseAsn1Time(textOf(timeNode))
  return { hashedMessage, genTime, serial, status }
}

export function randomNonce(bytes = 8): Uint8Array {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(bytes))
  nonce[0]! &= 0x7f
  if (nonce[0] === 0) nonce[0] = 1
  return nonce
}

/**
 * Ask an RFC 3161 TSA to stamp a SHA-256 hex digest. Tries each endpoint in
 * order; only the digest leaves the machine. `fetchImpl` is injectable for
 * tests (and for environments that route through a proxy).
 */
export async function requestRfc3161(
  workHashHex: string,
  opts: {
    fetchImpl?: typeof fetch
    endpoints?: TsaEndpoint[]
  } = {},
): Promise<Rfc3161Stamp> {
  const hash = workHashHex.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error('Timestamp needs a SHA-256 hex digest')
  }
  const doFetch = opts.fetchImpl ?? globalThis.fetch
  const query = encodeTimeStampReq(hash, randomNonce(8))
  const body = new Uint8Array(query.byteLength)
  body.set(query)
  let last = 'No time stamp authority answered'
  for (const tsa of opts.endpoints ?? TSA_ENDPOINTS) {
    try {
      const res = await doFetch(tsa.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/timestamp-query',
          accept: 'application/timestamp-reply',
        },
        body: body.buffer as ArrayBuffer,
      })
      if (!res.ok) {
        last = `${tsa.name} HTTP ${res.status}`
        continue
      }
      const der = new Uint8Array(await res.arrayBuffer())
      const parsed = parseTimeStampResp(der, hash)
      return {
        tsa: tsa.name,
        tsaUrl: tsa.url,
        tokenB64: bytesToBase64(der),
        ...parsed,
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
  }
  throw new Error(
    `Could not obtain an RFC 3161 timestamp (${last}). Retry when the network is up.`,
  )
}

/**
 * Offline check: the token is a well-formed TSA response binding exactly
 * `expectedHashHex`, with a sane generation time. (Full PKI chain validation
 * against TSA roots is future work — the token is retained for it.)
 */
export function verifyRfc3161Binding(
  tokenB64: string,
  expectedHashHex: string,
  nowMs = Date.now(),
): { genTime: string; serial: string } {
  let der: Uint8Array
  try {
    der = base64ToBytes(tokenB64)
  } catch {
    throw new Error('seal_bad_token_encoding')
  }
  const parsed = parseTimeStampResp(der, expectedHashHex)
  const genMs = new Date(parsed.genTime).getTime()
  if (Number.isNaN(genMs)) throw new Error('seal_bad_token_time')
  if (genMs > nowMs + 5 * 60 * 1000) {
    throw new Error('seal_token_from_future')
  }
  return { genTime: parsed.genTime, serial: parsed.serial }
}
