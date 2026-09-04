import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  base64UrlDecode,
  base64UrlEncode,
  buildLoginUrl,
  clearTwetchCaches,
  isVerifiedAccount,
  pkceChallenge,
  twetchBadge,
  verifyIdToken,
} from './twetch.js'

describe('twetch PKCE (S256)', () => {
  it('derives known-answer challenges (independent hashlib vectors)', async () => {
    assert.equal(
      await pkceChallenge('twetch-pkce-test-verifier-01'),
      'bz_SfzNG2yjZCY7mMB4ZLToxxInLjOARb8eoCQy3Ds0',
    )
    assert.equal(
      await pkceChallenge('hello'),
      'LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ',
    )
  })

  it('emits 43-char unpadded url-safe challenges', async () => {
    const c = await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')
    assert.equal(c.length, 43)
    assert.ok(/^[A-Za-z0-9_-]+$/.test(c))
  })

  it('base64url round-trips without padding', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    const enc = base64UrlEncode(bytes)
    assert.ok(!enc.includes('=') && !enc.includes('+') && !enc.includes('/'))
    assert.deepEqual(Array.from(base64UrlDecode(enc)), Array.from(bytes))
  })
})

describe('twetch login URL', () => {
  it('uses the discovery authorization endpoint with PKCE params', async () => {
    const issuer = 'https://id.example.com'
    const discovery = {
      issuer,
      authorization_endpoint: `${issuer}/auth`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    }
    // Stub fetch for discovery.
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(discovery), { status: 200 })) as typeof fetch
    try {
      const { authorizationUrl } = await buildLoginUrl(
        {
          issuer,
          clientId: 'bounties-web',
          redirectUri: 'https://app.example.com/twetch-callback',
        },
        { state: 's123', codeChallenge: 'c456' },
      )
      const u = new URL(authorizationUrl)
      assert.equal(u.origin + u.pathname, `${issuer}/auth`)
      assert.equal(u.searchParams.get('response_type'), 'code')
      assert.equal(u.searchParams.get('client_id'), 'bounties-web')
      assert.equal(
        u.searchParams.get('redirect_uri'),
        'https://app.example.com/twetch-callback',
      )
      assert.equal(u.searchParams.get('scope'), 'openid profile')
      assert.equal(u.searchParams.get('state'), 's123')
      assert.equal(u.searchParams.get('code_challenge'), 'c456')
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('twetch verification helpers', () => {
  it('detects verified accounts and builds badges', () => {
    assert.equal(isVerifiedAccount({}), false)
    assert.equal(isVerifiedAccount({ twetch: null }), false)
    const verified = {
      twetch: {
        sub: '42',
        handle: 'satoshi',
        verifiedAt: new Date().toISOString(),
      },
    }
    assert.equal(isVerifiedAccount(verified), true)
    assert.equal(twetchBadge(verified), '✓ Twetch @satoshi')
    assert.equal(twetchBadge({}), null)
  })
})

describe('twetch ID-token verification (ES256 + RS256)', () => {
  const ISSUER = 'https://id.example.com'
  const CLIENT = 'bounties-test'
  let origFetch: typeof fetch

  function b64urlJson(obj: unknown): string {
    return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)))
  }

  async function mintToken(opts: {
    alg: 'ES256' | 'RS256'
    kid: string
    sub?: string
    signKey: CryptoKey
    tamper?: boolean
  }): Promise<string> {
    const h = b64urlJson({ alg: opts.alg, kid: opts.kid, typ: 'JWT' })
    const now = Math.floor(Date.now() / 1000)
    const p = b64urlJson({
      iss: ISSUER,
      aud: CLIENT,
      sub: opts.sub ?? 'twetch-7',
      iat: now - 10,
      exp: now + 300,
      preferred_username: 'alice',
    })
    const input = new TextEncoder().encode(`${h}.${p}`)
    const signAlg =
      opts.alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : 'RSASSA-PKCS1-v1_5'
    let sig = new Uint8Array(
      await globalThis.crypto.subtle.sign(signAlg, opts.signKey, input),
    )
    if (opts.tamper) sig = Uint8Array.from(sig, (b, i) => (i === 0 ? b ^ 1 : b))
    return `${h}.${p}.${base64UrlEncode(sig)}`
  }

  async function withIssuer(
    jwks: Record<string, unknown>[],
    advertised: string[],
    fn: () => Promise<void>,
  ): Promise<void> {
    origFetch = globalThis.fetch
    clearTwetchCaches()
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url)
      if (u.endsWith('/.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/auth`,
            token_endpoint: `${ISSUER}/token`,
            jwks_uri: `${ISSUER}/jwks`,
            id_token_signing_alg_values_supported: advertised,
          }),
          { status: 200 },
        )
      }
      if (u === `${ISSUER}/jwks`) {
        return new Response(JSON.stringify({ keys: jwks }), { status: 200 })
      }
      throw new Error(`unexpected fetch ${u}`)
    }) as typeof fetch
    try {
      await fn()
    } finally {
      globalThis.fetch = origFetch
    }
  }

  it('verifies an ES256 token against an EC JWKS', async () => {
    const pair = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )
    const jwk = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey)
    await withIssuer([{ ...jwk, kid: 'ec1', use: 'sig' }], ['ES256'], async () => {
      const token = await mintToken({ alg: 'ES256', kid: 'ec1', signKey: pair.privateKey })
      const claims = await verifyIdToken({ idToken: token, issuer: ISSUER, clientId: CLIENT })
      assert.equal(claims.sub, 'twetch-7')
      assert.equal(claims.handle, 'alice')
    })
  })

  it('still verifies RS256 tokens', async () => {
    const pair = await globalThis.crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )
    const jwk = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey)
    await withIssuer(
      [{ ...jwk, kid: 'rsa1', use: 'sig' }],
      ['RS256', 'ES256'],
      async () => {
        const token = await mintToken({ alg: 'RS256', kid: 'rsa1', signKey: pair.privateKey })
        const claims = await verifyIdToken({ idToken: token, issuer: ISSUER, clientId: CLIENT })
        assert.equal(claims.sub, 'twetch-7')
      },
    )
  })

  it('rejects tampered signatures, wrong kids, and symmetric algs', async () => {
    const pair = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )
    const jwk = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey)
    await withIssuer([{ ...jwk, kid: 'ec1', use: 'sig' }], ['ES256'], async () => {
      const bad = await mintToken({ alg: 'ES256', kid: 'ec1', signKey: pair.privateKey, tamper: true })
      await assert.rejects(
        verifyIdToken({ idToken: bad, issuer: ISSUER, clientId: CLIENT }),
        /bad_signature/,
      )
      const unknownKid = await mintToken({ alg: 'ES256', kid: 'nope', signKey: pair.privateKey })
      await assert.rejects(
        verifyIdToken({ idToken: unknownKid, issuer: ISSUER, clientId: CLIENT }),
        /unknown_kid/,
      )
      // HS256 is never acceptable even if the issuer somehow advertised it.
      const h = b64urlJson({ alg: 'HS256', kid: 'ec1' })
      const p = b64urlJson({ iss: ISSUER, aud: CLIENT, sub: 'x' })
      await assert.rejects(
        verifyIdToken({ idToken: `${h}.${p}.bogus`, issuer: ISSUER, clientId: CLIENT }),
        /bad_alg/,
      )
    })
  })
})
