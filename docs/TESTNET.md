# BSV Testnet + sCrypt BountyEscrow

## Compile contracts

```bash
cd ~/ai-bounties
npm install
npm run compile -w @ai-bounties/contracts
# → packages/contracts/artifacts/bountyEscrow.json
npm run build -w @ai-bounties/contracts
```

Artifacts are committed under `packages/contracts/artifacts/` so consumers need not recompile. Re-run `compile` after editing `src/contracts/*.ts`.

## Configure testnet

```bash
cp .env.example .env
```

```env
NETWORK=test
BSV_NETWORK=test
ESCROW_MODE=scrypt
# Optional server-side demo deployer:
BSV_TESTNET_WIF=<your-testnet-wif>
```

## Fund a testnet wallet

1. Generate or use an existing WIF (Panda / Yours / scrypt TestWallet).
2. Request coins from a faucet (availability varies):
   - https://bsvfaucet.com/ (sign-in required)
   - https://scrypt.io/faucet
   - https://witnessonchain.com/faucet/tbsv
   - https://testnet.help/en/bsvfaucet/testnet
3. Check balance:

```bash
export BSV_TESTNET_WIF=...
npm run testnet:fund-info -w @ai-bounties/contracts
# or
curl -s http://localhost:8787/v1/chain | jq
```

## Deploy demo covenant (server key)

```bash
export BSV_TESTNET_WIF=...
export NETWORK=test
npm run testnet:deploy-demo -w @ai-bounties/contracts
```

Prints txid + https://test.whatsonchain.com/tx/...

## App flow with sCrypt locking script

1. Start API with `NETWORK=test` and `ESCROW_MODE=scrypt`.
2. Create a bounty with a **real compressed poster pubkey** (66 hex chars, `02`/`03` prefix):

```bash
curl -s -X POST http://localhost:8787/v1/bounties \
  -H 'content-type: application/json' \
  -d '{
    "title": "Testnet escrow job",
    "description": "Real BountyEscrow covenant on testnet",
    "category": "dev",
    "amountSats": 2000,
    "posterPubKey": "02…your compressed pubkey…",
    "useEscrow": true
  }' | jq '.createActionTemplate, .note'
```

3. Broadcast `createActionTemplate` with a BRC-100 wallet on **testnet** (Metanet / Yours / wallet-cli).
4. `PATCH /v1/bounties/:id/escrow` with `{ "escrowTxid": "…" }`.
5. Claim / submit / approve still run the app state machine and return next templates; full method-call txs can use `instance.methods.*` via scrypt-ts when the UTXO is tracked.

If `posterPubKey` is a demo string (not an EC key), the API falls back to P2PKH hold + state machine so local UI testing still works.

## Explorer

- Testnet: https://test.whatsonchain.com  
- API: https://api.whatsonchain.com/v1/bsv/test  

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `artifact not found` | `npm run compile -w @ai-bounties/contracts` |
| Transpile empty | Use repo `scripts/compile-scrypt.mjs` (forces TS 5.3) |
| Deploy fails “insufficient” | Faucet + wait for confirmations |
| Wrong network | Ensure wallet and `NETWORK=test` match |
