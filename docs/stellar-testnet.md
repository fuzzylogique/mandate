# Stellar testnet setup

The current app consists of the web dashboard, payments API, shared TypeScript
helpers and five Rust contracts. Both account options use Smart Accounts on
testnet. Both fund and pay with issued demo USD. One mandate flow uses USD
automatically, and the dashboard exposes only the actual USD token balance.

## Prerequisites

Install Node 24+, pnpm, Rust, the `wasm32v1-none` compilation target and the Stellar CLI.
Run commands from the repository root.

```bash
rustup target add wasm32v1-none
pnpm install
pnpm setup:payments
pnpm setup:contracts
pnpm dev
```

`setup:payments` writes the supported `.env` template and generates the encryption
key if missing. It preserves an existing key and contract settings.

`setup:contracts` uses the Stellar CLI identity named by `STELLAR_SOURCE`, defaulting
to `mandate-deployer`. It creates that identity if needed, funds it on testnet,
builds the contract workspace, uploads account code and deploys missing contracts.
It validates the resulting testnet configuration before saving it. The CLI seed is
captured privately and never printed. Re-running preserves configured contract IDs.

## Contracts used by the application

| Contract | Configuration | Purpose |
|---|---|---|
| `mandate-account` | `SMART_ACCOUNT_WASM_HASH` | Code for every user's Smart contract |
| `mandate-ed25519-verifier` | `ED25519_VERIFIER_ID` | Checks owner and delegate signatures |
| `mandate-spending-limit-policy` | `SPENDING_LIMIT_POLICY_ID` | Enforces rolling mandate spending limits |
| `mandate-seller-registry` | `SELLER_REGISTRY_ID` | Administrator attestations for recipient C addresses |
| `mandate-verified-smart-policy` | `PAYMENTS_VERIFIED_SMART_POLICY_ID` | Rejects unverified recipients and Classic G-address recipients |

Account opening creates a dedicated Classic wallet, activates it through Friendbot,
deploys its Smart contract, installs the USD owner payment rule and attests the C address.
The private `stellarPairs` mapping is one-to-one. The UI and public account API show
one account with the contract's C address and live USD balance.

For Stellar accounts, Add funds deposits demo USD into the mapped Classic wallet
and transfers it into Smart. For traditional accounts, it first credits simulated
USD in a private fiat ledger. The demo anchor issues 1 testnet USD token per demo
dollar into the mapped Classic trustline and forwards it through the USD Stellar
Asset Contract into Smart. The Classic wallet keeps its separate activation
and fee budget. Both funding steps use persisted transaction IDs; retries resume
without repeating a successful deposit. Payments transfer from Smart to Smart.

## Configuration

The API loads `.env` through its package script. Relative `PAYMENTS_CHAIN_DB` paths
are relative to `apps/receipts` when using `pnpm dev`. The default is `workspace.sqlite`.
The browser uses port 4020 and proxies API requests to port 4022. Keep `WEB_ORIGIN`
aligned with the browser origin if you change hosting.

The application payment asset is a local demo USD asset. XLM is used privately
for network fees and reserves. Its issuer key is
automatically generated and stored encrypted in the existing custody vault. The USD
Stellar Asset Contract is deployed automatically during account opening; no extra
environment settings or custom token WASM are needed. `/api/network` exposes both
the USD contract and public USD issuer. These USD tokens are not real dollars
or USDC. The local demo anchor does not implement SEP-6/SEP-24 or contact a bank.

Both account options use USD automatically. Every new mandate is scoped to the
USD asset contract. Existing XLM is preserved on chain without converting it or
counting it as USD. Older XLM mandates must be replaced with new USD mandates
for payments through the app.

RPC and Horizon must both use Stellar testnet. The API
checks network passphrases, configured contracts, registry administrator identity,
and custody-key access before starting. The RPC variable is `PAYMENTS_RPC_URL` so
the Stellar CLI does not implicitly consume it as `STELLAR_RPC_URL`.

Keep `PAYMENTS_ENCRYPTION_KEY` and the database together. Do not change an existing
database's verifier or spending policy configuration. Use a separate database for
a separate deployment. Databases with other workspace schemas are rejected rather
than rewritten.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:contracts
pnpm test:chain
```

The service tests use a fake network and real SQLite storage. The chain check uses
fresh testnet wallets, actual contracts and Friendbot funds. It checks one-to-one
mapping, demo USD issuance and forwarding for both options, Smart-to-Smart settlement,
third-party secret mandate IDs, idempotency, unverified-recipient refusal, asset
scoping, USD spending limits and revocation. It also verifies that hidden XLM
balances cannot be spent with a USD mandate.
It writes public transaction receipts to a temporary directory without printing keys.

The seller registry is an administrator attestation of an exact C address. Automatic
account opening does not perform KYC, business checks or domain ownership checks.

Legacy local traditional accounts retain their IDs and migrate their demo balances
to the new USD asset when the workspace loads. Migration is journaled and retryable.
Old service-only mandates are revoked and must be recreated. Historical simulated
receipts remain in Activity.
