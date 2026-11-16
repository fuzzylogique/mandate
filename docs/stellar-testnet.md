# Stellar testnet setup

The current app consists of the web dashboard, payments API, shared TypeScript
helpers and seven Rust contracts. All accounts use Smart Accounts on
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
| `mandate-ed25519-verifier` | `ED25519_VERIFIER_ID` | Checks owner signatures |
| `mandate-agent-registry` | `AGENT_REGISTRY_ID` | Account-scoped agent identification attestations |
| `mandate-agent-verifier` | `AGENT_VERIFIER_ID` | Requires a registered agent ID bound to each mandate payment signature |
| `mandate-spending-limit-policy` | `SPENDING_LIMIT_POLICY_ID` | Enforces rolling mandate spending limits |
| `mandate-seller-registry` | `SELLER_REGISTRY_ID` | Administrator attestations for recipient C addresses |
| `mandate-verified-smart-policy` | `PAYMENTS_VERIFIED_SMART_POLICY_ID` | Rejects unverified recipients and Classic G-address recipients |

Signup automatically creates a dedicated Classic wallet, activates it through Friendbot,
deploys its Smart contract, installs the USD owner payment rule and attests the C address.
The private `stellarPairs` mapping is one-to-one. The UI and public account API show
one account with the contract's C address and live USD balance.

Each user has one main account. Agents are registered separately for identification, without their own funds or spending permissions. In Add funds, choose FIAT for demo USD or Testnet for the automatic Stellar testnet flow. Both use direct demo USD funding, with no private fiat ledger.
Enter an amount and click Add funds. The service establishes a trustline in the
mapped Classic wallet, issues the exact requested amount of demo USD into it,
and forwards the tokens through their Stellar Asset Contract into Smart.
The Classic wallet retains its XLM activation and fee budget. Both transactions
persist before broadcast, so retries resume issuance and forwarding without
crediting twice. A successful receipt is recorded only after forwarding confirms.
Payments transfer from Smart to Smart.

## Configuration

The API loads `.env` through its package script. Relative `PAYMENTS_CHAIN_DB` paths
are relative to `apps/receipts` when using `pnpm dev`. The default is `workspace.sqlite`.
The browser uses port 4020 and proxies API requests to port 4022. Keep `WEB_ORIGIN`
aligned with the browser origin if you change hosting.

The payment asset is a locally issued demo USD token on Stellar testnet. Its
issuer key is generated once and encrypted in the custody vault. The Stellar
Asset Contract is deployed automatically during account opening; `/api/network`
exposes the public issuer and token contract. There is no external funding provider
or hosted onboarding. These tokens represent fake demo dollars, not real money
or USDC. Add funds accepts positive amounts with up to two decimal places and a
maximum of 1,000,000 demo USD per request.

All accounts use USD automatically. Every new mandate is scoped to the
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
mapping, direct demo USD issuance and forwarding for both options, Smart-to-Smart settlement,
third-party secret mandate IDs with on-chain agent identification, idempotency, unverified-recipient refusal, asset
scoping, USD spending limits and revocation. It also verifies that hidden XLM
balances cannot be spent with a USD mandate.
It writes public transaction receipts to a temporary directory without printing keys.

The seller registry is an administrator attestation of an exact C address. Automatic
account opening does not perform KYC, business checks or domain ownership checks.

Legacy local traditional accounts retain their IDs and upgrade their demo
balances exactly once when the workspace loads. Old service-only mandates are
revoked and must be recreated. The live payment script runs automatically with
fresh testnet wallets and demo USD, without hosted deposit steps.
