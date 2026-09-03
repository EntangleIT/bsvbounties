/**
 * Twetch OIDC verified identity ("Sign in with Twetch").
 *
 * Links a numbered AI Bounties account to a stable Twetch user id
 * (`sub` from the issuer's ID token). One Twetch identity may verify at
 * most one account — that is the Sybil-resistance primitive the escrow,
 * bonds, and reputation layers build on.
 *
 * Isomorphic: global fetch + WebCrypto only, no dependencies. Works in
 * Node 18+, browsers, and Cloudflare Workers.
 */

export interface TwetchIdentity {
  /** Stable Twetch user id (OIDC `sub`). Survives key rotation. */
  sub: string
  /** Twetch handle (`preferred_username`), if the issuer provided one. */
  handle?: string
  /** Display name (`name`), if provided. */
  displayName?: string
  /** Avatar URL (`picture`), if provided. */
  avatarUrl?: string
  /** Public profile URL (`profile`), if provided. */
  profileUrl?: string
  /** Current Twetch signing pubkey (`twetch_pubkey`), if provided. */
  pubkey?: string
  /** ISO timestamp of when this account was linked. */
  verifiedAt: string
}

export interface TwetchRpConfig {
  /** Issuer base URL, e.g. https://id.entangleit.com */
  issuer: string
  /** OIDC client id registered at the issuer. */
  clientId: string
  /** Redirect URI registered at the issuer (web callback page or oob). */
  redirectUri: string
  /**
   * Client secret for confidential clients. Optional: public PKCE-only
   * clients omit it. NEVER commit — `wrangler secret put` / server env only.
   */
  clientSecret?: string
}

export function isVerifiedAccount(a: {
  twetch?: TwetchIdentity | null
}): boolean {
  return typeof a.twetch?.sub === 'string' && a.twetch.sub.length > 0
}

export function twetchBadge(a: {
  twetch?: TwetchIdentity | null
}): string | null {
  if (!isVerifiedAccount(a)) return null
  const handle = a.twetch?.handle
  return handle ? `✓ Twetch @${handle}` : '✓ Twetch verified'
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636, S256) + authorization URL
// ---------------------------------------------------------------------------

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlDecode(input: string): Uint8Array {
  const b64 =
    input.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (input.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Cryptographically random URL-safe string (state, PKCE verifier). */
export function randomUrlSafe(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buf)
  return base64UrlEncode(buf)
}

/** S256 code challenge for a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  )
  return base64UrlEncode(new Uint8Array(digest))
}

export interface OidcDiscovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint?: string
  jwks_uri: string
}

const discoveryCache = new Map<string, { at: number; doc: OidcDiscovery }>()
const DISCOVERY_TTL_MS = 5 * 60 * 1000

export function clearTwetchCaches(): void {
  discoveryCache.clear()
  jwksCache.clear()
}

export async function fetchDiscovery(issuer: string): Promise<OidcDiscovery> {
  const key = issuer.replace(/\/$/, '')
  const hit = discoveryCache.get(key)
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.doc
  const url = `${key}/.well-known/openid-configuration`
  let res: Response
  try {
    res = await fetch(url)
  } catch (e) {
    throw new Error(
      `twetch_discovery_unreachable: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  if (!res.ok) {
    throw new Error(`twetch_discovery_http_${res.status}`)
  }
  const doc = (await res.json()) as OidcDiscovery
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error('twetch_discovery_invalid: missing endpoints')
  }
  discoveryCache.set(key, { at: Date.now(), doc })
  return doc
}

export async function buildLoginUrl(
  config: TwetchRpConfig,
  opts: { state: string; codeChallenge: string },
): Promise<{ authorizationUrl: string; discovery: OidcDiscovery }> {
  const discovery = await fetchDiscovery(config.issuer)
  const u = new URL(discovery.authorization_endpoint)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', config.clientId)
  u.searchParams.set('redirect_uri', config.redirectUri)
  u.searchParams.set('scope', 'openid profile')
  u.searchParams.set('state', opts.state)
  u.searchParams.set('code_challenge', opts.codeChallenge)
  u.searchParams.set('code_challenge_method', 'S256')
  return { authorizationUrl: u.toString(), discovery }
}

// ---------------------------------------------------------------------------
// Code exchange + ID-token verification (RS256, JWKS)
// ---------------------------------------------------------------------------

export interface TwetchCodeExchange {
  idToken: string
  accessToken?: string
}

export async function exchangeCode(opts: {
  tokenEndpoint: string
  code: string
  codeVerifier: string
  redirectUri: string
  clientId: string
  clientSecret?: string
  fetchImpl?: typeof fetch
}): Promise<TwetchCodeExchange> {
  const doFetch = opts.fetchImpl ?? fetch
  const body = new URLSearchParams()
  body.set('grant_type', 'authorization_code')
  body.set('code', opts.code)
  body.set('redirect_uri', opts.redirectUri)
  body.set('client_id', opts.clientId)
  body.set('code_verifier', opts.codeVerifier)
  if (opts.clientSecret) body.set('client_secret', opts.clientSecret)
  let res: Response
  try {
    res = await doFetch(opts.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
  } catch (e) {
    throw new Error(
      `twetch_token_unreachable: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(
      `twetch_token_rejected: http_${res.status} ${text.slice(0, 160)}`,
    )
  }
  const json = (await res.json()) as {
    id_token?: string
    access_token?: string
    error?: string
  }
  if (!json.id_token) {
    throw new Error(
      `twetch_token_no_id_token: ${json.error ?? 'missing id_token'}`,
    )
  }
  return { idToken: json.id_token, accessToken: json.access_token }
}

export interface VerifiedTwetchClaims {
  sub: string
  handle?: string
  displayName?: string
  avatarUrl?: string
  profileUrl?: string
  pubkey?: string
  email?: string
}

const jwksCache = new Map<string, { at: number; keys: JsonWebKey[] }>()
const JWKS_TTL_MS = 5 * 60 * 1000

async function fetchJwks(uri: string): Promise<JsonWebKey[]> {
  const hit = jwksCache.get(uri)
  if (hit && Date.now() - hit.at < JWKS_TTL_MS) return hit.keys
  const res = await fetch(uri)
  if (!res.ok) throw new Error(`twetch_jwks_http_${res.status}`)
  const json = (await res.json()) as { keys?: JsonWebKey[] }
  if (!Array.isArray(json.keys)) throw new Error('twetch_jwks_invalid')
  jwksCache.set(uri, { at: Date.now(), keys: json.keys })
  return json.keys
}

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/$/, '')
}

/**
 * Verify an OIDC ID token against the issuer's JWKS. RS256 only —
 * `none` and symmetric algs are always rejected.
 */
export async function verifyIdToken(opts: {
  idToken: string
  issuer: string
  clientId: string
  jwksUri?: string
  nowMs?: number
}): Promise<VerifiedTwetchClaims> {
  const parts = opts.idToken.split('.')
  if (parts.length !== 3) throw new Error('twetch_id_token_malformed')
  const [hB64, pB64, sB64] = parts as [string, string, string]
  let header: { alg?: string; kid?: string }
  let payload: Record<string, unknown>
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(hB64)))
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(pB64)))
  } catch {
    throw new Error('twetch_id_token_malformed')
  }
  if (header.alg !== 'RS256') throw new Error('twetch_id_token_bad_alg')
  if (!header.kid) throw new Error('twetch_id_token_no_kid')

  let jwksUri = opts.jwksUri
  if (!jwksUri) {
    const discovery = await fetchDiscovery(opts.issuer)
    jwksUri = discovery.jwks_uri
  }
  const keys = await fetchJwks(jwksUri)
  const jwk = keys.find(
    (k) =>
      (k as { kid?: string }).kid === header.kid &&
      (k as { kty?: string }).kty === 'RSA',
  )
  if (!jwk) throw new Error('twetch_id_token_unknown_kid')

  const key = await globalThis.crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const signingInput = new TextEncoder().encode(`${hB64}.${pB64}`)
  const signatureBuf = new Uint8Array(base64UrlDecode(sB64))
  const ok = await globalThis.crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signatureBuf,
    signingInput,
  )
  if (!ok) throw new Error('twetch_id_token_bad_signature')

  const now = Math.floor((opts.nowMs ?? Date.now()) / 1000)
  if (normalizeIssuer(String(payload.iss ?? '')) !== normalizeIssuer(opts.issuer)) {
    throw new Error('twetch_id_token_bad_iss')
  }
  const aud = payload.aud
  const audOk =
    aud === opts.clientId ||
    (Array.isArray(aud) && aud.includes(opts.clientId))
  if (!audOk) throw new Error('twetch_id_token_bad_aud')
  if (typeof payload.exp !== 'number' || payload.exp <= now - 60) {
    throw new Error('twetch_id_token_expired')
  }
  if (typeof payload.iat === 'number' && payload.iat > now + 300) {
    throw new Error('twetch_id_token_issued_in_future')
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('twetch_id_token_no_sub')
  }

  const claims: VerifiedTwetchClaims = { sub: payload.sub }
  if (typeof payload.preferred_username === 'string') {
    claims.handle = payload.preferred_username
  }
  if (typeof payload.name === 'string') claims.displayName = payload.name
  if (typeof payload.picture === 'string') claims.avatarUrl = payload.picture
  if (typeof payload.profile === 'string') claims.profileUrl = payload.profile
  if (typeof payload.twetch_pubkey === 'string') {
    claims.pubkey = payload.twetch_pubkey
  }
  if (typeof payload.email === 'string') claims.email = payload.email
  return claims
}

export function identityFromClaims(
  claims: VerifiedTwetchClaims,
  nowIso?: string,
): TwetchIdentity {
  return {
    sub: claims.sub,
    handle: claims.handle,
    displayName: claims.displayName,
    avatarUrl: claims.avatarUrl,
    profileUrl: claims.profileUrl,
    pubkey: claims.pubkey,
    verifiedAt: nowIso ?? new Date().toISOString(),
  }
}
