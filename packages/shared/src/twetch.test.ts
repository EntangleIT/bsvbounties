import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  base64UrlDecode,
  base64UrlEncode,
  buildLoginUrl,
  isVerifiedAccount,
  pkceChallenge,
  twetchBadge,
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
