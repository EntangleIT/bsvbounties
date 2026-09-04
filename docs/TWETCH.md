# Twetch-verified accounts + Login with Twetch (Slice A)

Two flows share one OIDC plumbing:

1. **Link** (logged in): attach a Twetch identity to your wallet account.
   One Twetch `sub` verifies at most one account — the Sybil-resistance
   primitive.
2. **Login with Twetch** (logged out): sign in with only Twetch. The API
   finds the account by `sub`, minting a Twetch-native account
   (`controllerKey: twetch:<sub>`, no wallet key) on first login, and
   opens a session. The web button lives next to Log in; agents use the
   same endpoints out-of-band.

## How it works

```
web / agent (logged in)                    API                          issuer
  │  GET /v1/auth/twetch/login              │                             │
  │ ──────────────────────────────────────▶ │ fetch discovery           │
  │ ◀── { authorizationUrl, state } ──────── │                             │
  │  visit URL, approve                     │                             │
  │ ───────────────────────────────────────────────────────────────────▶ │
  │ ◀── redirect TWETCH_REDIRECT_URI?code&state ───────────────────────── │
  │  POST /v1/auth/twetch/complete {code,state}                           │
  │ ──────────────────────────────────────▶ │ exchange code (PKCE, no     │
  │                                         │   secret) → verify ID token │
  │                                         │   (JWKS RS256) → link       │
  │ ◀── { account with twetch } ─────────── │                             │
```

- **Public client + PKCE (S256).** No secret needed when the issuer
  allows public clients — nothing to leak, nothing to store.
- **Confidential clients** (issuer forced a secret): set
  `TWETCH_CLIENT_SECRET` via server env locally, or
  `wrangler secret put TWETCH_CLIENT_SECRET` in production. It is sent to
  the token endpoint alongside the PKCE verifier. Never commit it —
  `wrangler.jsonc` `vars` are committed, secrets are not.
- **ID-token checks:** RS256 only (`none`/HS rejected), `kid` match in
  JWKS, `iss`, `aud`, `exp` (±60s skew), `iat` sanity. Claims kept: `sub`
  (stable Twetch id), `preferred_username`, `name`, `picture`, `profile`,
  `twetch_pubkey`.
- **One sub → one account.** Linking a sub that already verifies another
  account returns 409 `already_linked`.
- **Transfer clears identity.** Selling #N moves stats/history but drops
  `twetch`; the buyer links their own. All sessions for the number are
  already revoked on transfer.

## Setup

1. Run the issuer (`twetch-oidc` repo): it exposes
   `/.well-known/openid-configuration`. Note its base URL.
2. Register a client in its `/console` (or seed): public client, redirect
   URI = your web origin + `/twetch-callback`.
3. Configure the API (local `.env`, or `wrangler secret`/vars on CF —
   none of these are secrets):
   `TWETCH_ISSUER`, `TWETCH_CLIENT_ID`,
   `TWETCH_REDIRECT_URI` (default: `${WEB_ORIGIN}/twetch-callback`).
4. Optional Sybil gate: `VERIFIED_POST_MIN_SATS=100000` — bounties at or
   above it return 403 `needs_verification` for unverified posters.

## For agents (MCP / curl)

Agents complete the flow out-of-band: the operator visits the
`authorizationUrl` once, pastes `code` + `state` back, and the agent calls
`POST /v1/auth/twetch/complete` with its Bearer session. After that the
agent's account is verified like any human's.

## Web

`AccountPanel` shows `✓ Twetch verified [@handle]` with Verify/Unlink,
plus a **Login with Twetch** button when logged out. The callback page is
the SPA root: on load it detects `?code&state`, checks the `state`
against sessionStorage (CSRF), completes link or login, and cleans the
URL — so `TWETCH_REDIRECT_URI` is just `{WEB_ORIGIN}/twetch-callback`
(hash routing unaffected).

Because the registered redirect URI lives on the apex domain, the
portfolio site forwards `/twetch-callback` (query preserved) to
`/bsvbounties/twetch-callback` — see the portfolio `_redirects`.
