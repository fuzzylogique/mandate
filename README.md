# Mandate

An email/password payment workspace with two account types:

- **Traditional account:** simulated USD banking with a local ledger.
- **Stellar account:** one visible account with a Smart Account C address and XLM balance on Stellar testnet.

The login holds no money. Every Stellar account has a private, one-to-one mapping
between its Smart contract and a Classic wallet. Opening and funding manage both
in the background. Users never select or manage the Classic wallet.

## Run

For this configured checkout:

```bash
pnpm dev
```

Open http://localhost:4020. The dashboard runs on port 4020 and proxies `/api` to
the payments API on port 4022.

For a fresh checkout, install Node 24+, pnpm, Rust with the `wasm32v1-none` target,
and the Stellar CLI, then run:

```bash
pnpm install
pnpm setup:payments
pnpm setup:contracts
pnpm dev
```

`setup:payments` creates `.env` and a custody encryption key. Re-running it
preserves existing supported settings and the key. `setup:contracts` builds the
current contracts, uploads the account WASM, deploys missing shared contracts,
and privately saves the registry administrator key. Existing configured contracts
are reused. See [Stellar setup](docs/stellar-testnet.md).

## Accounts and funding

Choose **Accounts → Open account**, select Traditional or Stellar, and enter a name.
Both start with zero visible balance.

Traditional accounts use the fictional **Mandate Demo Bank**, a `DEMO-…` account
number and a `BANK_DEMO_…` recipient reference. **Add funds** credits simulated USD
directly to that account. Traditional payments transfer those balances between
verified demo recipients. USD amounts accept up to two decimal places. There is
no bank-provider integration or conversion between demo USD and XLM.

For Stellar accounts, opening automatically provisions a dedicated Classic wallet,
deploys the Smart contract, installs its payment policy, and registers the contract
as a verified recipient. The Classic wallet holds testnet XLM for reserves and fees;
the dashboard shows only the Smart contract's balance and C address.

**Add funds** accepts an XLM amount and automatically:

1. Deposits that amount into the account's mapped Classic wallet using the testnet funding provider.
2. Transfers it into the mapped Smart contract.

Both transactions are persisted independently before broadcast. Repeating the same
request resumes an interrupted operation without depositing or transferring twice.
Only confirmed funding is reported as successful. The provider uses Friendbot-funded
source wallets and accepts amounts within their available testnet allowance.

Stellar payments transfer XLM from one Smart contract to another verified Smart
contract. Classic G addresses cannot be used as payment recipients. XLM amounts
accept up to seven decimal places.

The **Activity** tab shows funding and payments. Traditional entries are marked as
simulated; Stellar entries include transaction hashes and explorer links.

## Mandates and third-party payments

A mandate grants a person or agent spending access to an existing account.
Creating one does not open another account or create another balance.

1. Open **Mandates** and choose Traditional or Stellar payment.
2. Select a verified source account matching that method.
3. Enter the holder, limit, period and expiry.
4. Save the displayed payment credential, mandate ID and Pay link.

Traditional mandates enforce limits in fixed 24-hour, 7-day or 30-day periods in
the service. Stellar mandates install an on-chain signer with a rolling spending
limit, ledger expiry and verified-recipient policy. The API also checks wall-clock
expiry. Several mandates can share an account, each with its own allowance.
Revocation blocks service access immediately; a pending on-chain revocation remains
visible and retryable.

The holder opens `/pay` without an owner login, enters the credential and payment
details, and chooses **Check mandate & seller** before **Make payment**. Use the
recipient's demo reference for Traditional payments or C address for Stellar payments.
The Pay link contains the mandate ID and method, never its secret credential.

Wrong credentials, incompatible payment methods, unverified recipients, exceeded
limits, expiry, revocation and insufficient funds decline payment. Unchanged
retries reuse the same request ID. Pending blockchain transactions are shown as
pending rather than paid.

## Seller verification

Stellar verification uses **an on-chain registry entry keyed by the exact recipient
Smart Account C address**. A valid address or seller display name alone does not
establish verification.

When opening an account, the service checks that the deployed contract responds
to `get_context_rule(0)`. The registry administrator then calls
`register(C_address, "workspace/<account-id>")`. The registry stores that address,
metadata and verification ledger. Only its administrator can register or revoke entries.

Before payment, the API calls `is_verified(C_address)`. The sender's payment policy
checks that same registry during on-chain authorization. A mandate additionally
checks its spending limit. Revoking a recipient's registry entry blocks later payments.

The prototype automatically attests accounts it opens. It does not perform KYC,
business verification or domain-ownership verification. Traditional verification is
only a local demo flag.

## Configuration and storage

[.env.example](.env.example) lists all supported settings. Never commit `.env`.

| Setting | Purpose |
|---|---|
| `PAYMENTS_CHAIN_DB` | Workspace, demo-bank ledger, encrypted custody vault and transaction journal; defaults to `workspace.sqlite` in the API directory |
| `PAYMENTS_ENCRYPTION_KEY` | 32-byte hex custody key generated by `setup:payments` |
| `PAYMENTS_RPC_URL` | Stellar testnet RPC endpoint |
| `PAYMENTS_HORIZON_URL` | Testnet account activation lookup |
| `PAYMENTS_FRIENDBOT_URL` | Testnet activation and funding provider |
| `PAYMENTS_EXPLORER_URL` | Base URL for account and transaction links |
| `SMART_ACCOUNT_WASM_HASH` | Uploaded account code used to deploy each Smart contract |
| `ED25519_VERIFIER_ID` | Contract verifying account and mandate signatures |
| `SPENDING_LIMIT_POLICY_ID` | On-chain mandate spending limits |
| `SELLER_REGISTRY_ID` | Verified recipient registry |
| `PAYMENTS_VERIFIED_SMART_POLICY_ID` | Policy requiring verified C-address recipients |
| `PAYMENTS_REGISTRY_ADMIN_SECRET` | Testnet registry administrator key |
| `STELLAR_SOURCE` | Stellar CLI identity used by `setup:contracts`; defaults to `mandate-deployer` |
| `WEB_ORIGIN` | Allowed browser origin; defaults to `http://localhost:4020` |
| `RECEIPTS_PORT` | Payments API port; defaults to `4022` |
| `NODE_ENV` | Set to `production` for Secure session cookies; requires HTTPS |

Signing keys and cached command responses are encrypted with AES-256-GCM. Passwords
use salted scrypt hashes; sessions and payment credentials are stored as hashes.
Demo-bank mutations commit atomically in SQLite. Stellar envelopes persist before
broadcast and retain their original transaction IDs on retries.

Keep the encryption key with its database. Changing keys or contract configuration
requires a separate database. The current application opens only its current
workspace schema and does not migrate other database layouts.

## API

| Route | Purpose |
|---|---|
| `POST /api/auth/register`, `/api/auth/login`, `/api/auth/logout` | Email/password sessions |
| `GET /api/workspace` | Visible accounts, mandates and activity |
| `POST /api/accounts/open` | Open with `type: "traditional"` or `"stellar"`, name and request ID |
| `POST /api/accounts/:id/funding` | Add funds to that account; requires amount and request ID |
| `POST /api/mandates` | Create a mandate on an existing source account |
| `DELETE /api/mandates/:id` | Revoke a mandate |
| `POST /api/payments` | Owner or delegate payment |
| `POST /api/pay/preview`, `/api/pay` | Third-party checks and payment with an Authorization Bearer credential |
| `GET /api/network`, `/api/health` | Testnet metadata and service status |

Traditional successes have `settlement: "traditional-demo"` and a demo receipt ID.
Stellar successes have `settlement: "stellar-testnet"`, a `txHash` and explorer link.
Owner cookies do not replace the payment credential on the public Pay endpoints.

## Checks

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:contracts
```

To verify real contract deployment, automatic funding, Smart-to-Smart payments,
mandate limits and revocation with fresh wallets and testnet funds:

```bash
pnpm test:chain
```

Public verification receipts are in
[stellar-account-verification.json](docs/stellar-account-verification.json).
Traditional banking is simulated and Stellar payments use testnet only.
