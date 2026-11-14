# Mandate

An email/password payment workspace with two account types:

- **Traditional account:** demo USD funding, settled as issued USD tokens on Stellar testnet.
- **Stellar account:** a USD Smart Account on Stellar testnet.

Both expose one Smart Account C address and use the same on-chain mandate and payment system.

The login holds no money. Every account has a private, one-to-one mapping
between its Smart contract and a Classic wallet. Traditional accounts also have
a private demo fiat ledger connected to the demo anchor. Opening and funding manage both
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

Both account options automatically provision a dedicated Classic wallet, deploy a
Smart contract, install asset-specific payment policies, and register the C address
as a verified recipient. The dashboard shows the Smart Account address and live
USD balance. The fiat ledger and Classic wallet remain private.

**Traditional Add funds** accepts demo USD with up to two decimal places:

1. Credit hardcoded, simulated USD in the account's private fiat ledger.
2. The demo anchor consumes that credit and issues the same amount of testnet USD
   into the mapped Classic wallet, creating its trustline automatically.
3. Transfer the USD tokens through their Stellar Asset Contract into the mapped Smart Account.

The USD issuer key is generated once and encrypted in the database's custody vault.
Its public issuer address and token contract are available in `/api/network`.
This token represents fake demo dollars, not USDC or redeemable money. The anchor
is a local demo adapter; it does not connect to a bank or implement a hosted SEP-24 service.

**Stellar Add funds** also deposits demo USD tokens into the mapped Classic wallet,
then transfers them into Smart. Both account options accept USD amounts with up to
two decimal places. The Classic wallet retains XLM privately for reserves and fees.

Both funding transactions persist before broadcast. Repeating an unchanged request
resumes interrupted funding without issuing fiat, depositing tokens or forwarding
them twice. Only confirmed forwarding creates a successful funding receipt.

All payments transfer from a Smart C address to another verified Smart C address.
Both account options fund, receive and spend the same demo USD token. The dashboard
shows only the actual on-chain USD balance. Smart Account addresses start masked;
**Show Smart Account address** reveals them, and **Hide Smart Account address**
masks them again. **Copy Smart Account address** works while masked. Mandates and payments always use USD,
with no currency selector. Classic G addresses are not payment recipients.
Payments and mandate limits retain seven decimal places; deposits accept two.
Existing XLM remains on chain and is not converted into or displayed as USD.

The **Activity** tab shows confirmed funding and payment transactions with explorer
links. Older local demo receipts remain marked as historical simulated activity.
The dashboard refreshes when returning to its tab and every 15 seconds.
Payments back to the source account are rejected.

## Mandates and third-party payments

There is one mandate flow for both account options. A mandate grants a person or
agent spending access to an existing Smart Account's USD balance.
Creating one does not open an account or create another balance.

1. Open **Mandates** and select a verified source account.
2. Enter the holder, USD limit, rolling period and expiry.
3. Use **Show mandate** to reveal and save the secret mandate ID. The Pay link is simply `/pay`.

Every new mandate installs an on-chain signer and an asset-scoped contract rule,
with a rolling spending limit, ledger expiry and verified-recipient policy.
The API also checks wall-clock expiry. Several mandates can share an account,
each with its own allowance. A USD mandate cannot authorize an XLM transfer.
Revocation disables the secret ID immediately; pending on-chain revocation remains
visible and retryable until the rule is removed.

The holder opens `/pay` without an owner login, enters the secret mandate ID and
the seller's Smart Account C address copied from their dashboard, then checks and
submits the payment. The mandate determines the buyer's source account and currency;
there is no payment-method selector. The recipient's display name does not establish verification.

The secret ID is a bearer credential. It never appears in links or receipts.
The Pay page always masks it. The owner's dashboard reveals it only after
**Show mandate**, and clears it after **Hide mandate**. **Copy mandate ID** retrieves
the secret through the owner-authenticated endpoint and copies it without revealing
it in the field. Copy buttons work while masked or visible.
Invalid IDs, unverified recipients, limits, expiry, revocation and insufficient
funds decline payment. Unchanged retries reuse their request ID. Pending blockchain
transactions are reported as pending until confirmed.

Existing local traditional accounts are upgraded when their workspace loads:
their old demo balances are anchored exactly once into testnet USD, with recovery
across restarts. Old service-only mandates are retained as revoked records and must
be recreated; their prior permissions are not silently renewed. Existing Stellar
accounts retain their addresses. Older XLM mandate rules retain their original
asset scope and must be replaced with a new USD mandate to pay through the app.

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
business verification or domain-ownership verification. Both account options use
this same registry verification.

## Configuration and storage

[.env.example](.env.example) lists all supported settings. Never commit `.env`.

| Setting | Purpose |
|---|---|
| `PAYMENTS_CHAIN_DB` | Workspace, private demo fiat/anchor journal, encrypted custody vault and transaction journal; defaults to `workspace.sqlite` in the API directory |
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

Signing keys, secret mandate IDs and cached command responses are encrypted with
AES-256-GCM. Passwords use salted scrypt hashes; sessions and mandate IDs are
authenticated by their hashes. Ordinary workspace, preview and payment responses
exclude the secret ID. Records and receipts use a separate non-secret `reference`
for management and auditing. The on-chain rule ID and signing mechanism are unchanged.
Demo fiat and anchor journal mutations commit atomically in SQLite. Stellar envelopes persist before
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
| `POST /api/mandates/:reference/reveal` | Owner-only retrieval of the secret mandate ID for Show mandate |
| `DELETE /api/mandates/:reference` | Revoke a mandate using its non-secret record reference |
| `POST /api/payments` | Owner or delegate payment |
| `POST /api/pay/preview`, `/api/pay` | Third-party checks and payment using the secret `mandateId` in the JSON body |
| `GET /api/network`, `/api/health` | Testnet metadata and service status |

All new funding and payment successes have `settlement: "stellar-testnet"`, a
`txHash` and explorer link. All new receipts use USD.
Mandate creation and payments require no currency input; explicit non-USD
requests are rejected. Public Pay requests derive the buyer's account from the mandate.
Public Pay endpoints require the secret `mandateId` in the JSON body. They do not
use an owner cookie or a separate Authorization Bearer token. The owner-authenticated
creation response is `{ mandate, mandateId }`; its `mandate.reference` is not a
payment authorization. Secrets are never put in links, receipts or on-chain arguments.

## Checks

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:contracts
```

Browser checks verify masking, explicit dashboard reveal, copying masked IDs and
addresses, and payment without a separate credential. Install Chromium once, then run them:

```bash
pnpm --filter @mandate/web exec playwright install chromium
pnpm test:ui
```

To verify real contract deployment, automatic funding, Smart-to-Smart payments,
mandate limits and revocation with fresh wallets and testnet funds:

```bash
pnpm test:chain
```

Current USD anchor and unified mandate verification receipts are in
[unified-mandate-verification.json](docs/unified-mandate-verification.json).
Earlier XLM-only verification receipts are in
[stellar-account-verification.json](docs/stellar-account-verification.json).
Verification of payments using only the secret mandate ID is in
[secret-mandate-verification.json](docs/secret-mandate-verification.json).
Fiat funding is simulated; all new payment settlement uses Stellar testnet only.
