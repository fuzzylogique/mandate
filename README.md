# Mandate

An email/password payment workspace with one main account per user. Signup automatically provisions a private Classic wallet and a verified Smart Account. Choose **FIAT** or **Testnet** when adding funds.

The dashboard shows your main account and USD balance at the top, followed by **Agents**, **Mandates** and **Activity**. There is no separate account-opening step. The Classic wallet stays private and is managed automatically.

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

Create an account with your name, email and password. Your main account starts with zero USD balance and is ready to fund after signup. If network setup is interrupted, sign in again to resume the same wallet pair.

Signup automatically provisions a dedicated Classic wallet, deploys a
Smart contract, installs asset-specific payment policies, and registers the C address
as a verified recipient. The dashboard shows the Smart Account address and live
USD balance. The Classic wallet remains private.

**Add funds** in the main account summary offers two methods: **FIAT** opens Stripe hosted Checkout using sandbox/test cards; **Testnet** uses the automatic Stellar testnet funding flow. No real money is charged. Both credit the same on-chain USD balance:

1. Choose FIAT or Testnet and enter a USD amount with up to two decimal places. FIAT accepts 0.50–999,999.99 USD; Testnet accepts up to 1,000,000 USD.
2. For FIAT, click **Continue to Stripe** and complete the test card checkout. The API verifies that the Stripe session is paid, in test mode, and matches the stored account and amount. Signed webhooks complete funding even if you close the browser; returning to the dashboard also checks confirmation. For Testnet, click **Add funds**.
3. The demo issuer sends that exact amount to the account's mapped Classic wallet, creating its USD trustline automatically.
4. The service forwards the USD tokens through their Stellar Asset Contract into the Smart Account.
5. After forwarding confirms, the dashboard refreshes its on-chain USD balance and shows the funding receipt.

Stripe sandbox payments authorize demo funding; they do not transfer real dollars or mint redeemable assets. Checkout requests and confirmed funding are persisted so retries and duplicate webhooks reuse the same checkout and credit once. Cancelled, unpaid, expired or mismatched sessions do not credit the account.
The local demo issuer's private key is encrypted in the custody vault and reused
across restarts. Its public issuer address and token contract are exposed in
`/api/network`. These tokens represent fake demo dollars, not USDC or redeemable money.
The Classic wallet retains XLM privately for reserves and fees.

Deposits accept up to 1,000,000 demo USD per request. Both funding transactions
persist before broadcast. Repeating an unchanged request resumes interrupted
funding without issuing or forwarding tokens twice. Only confirmed forwarding
creates a successful funding receipt.

All payments transfer from a Smart C address to another verified Smart C address.
All accounts fund, receive and spend the same demo USD token. The dashboard
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

## Agents and on-chain identification

The **Agents** tab lists the agents associated with your main account. **Add agent** registers a name and a stable public identification value (`agt_…`). Agents have no balance or spending limits of their own. Any agent registered to an account can use any of that account's mandates.

The service attests `(Smart Account C address, agent ID)` in an administrator-controlled agent registry, following the seller-verification pattern. Registrations appear only after chain confirmation, and the dashboard checks their current on-chain status. Agent names are display labels; the registry entry determines membership. Identification is public and is not a separate bearer secret or proof of legal identity.

Payments require both the secret `mandateId` and the registered `agentId`. The mandate verifier checks the on-chain registry during Smart Account authorization. The mandate signature binds the agent ID to the account, rule and payment digest, and emits an on-chain agent authorization event. Foreign, missing, unknown or revoked identities cannot authorize a mandate payment. The API records `agentId` in activity and receipts. Existing mandate rules are upgraded before payment by replacing the old signer with the agent-aware verifier; their limits and spending history remain intact.

Run `pnpm setup:contracts` for an existing checkout to deploy the agent registry and verifier and save their IDs. Existing agents are never inferred from mandate-holder names.

## Stripe sandbox setup

1. In your [Stripe sandbox](https://docs.stripe.com/testing), get a test secret key and set `STRIPE_SECRET_KEY=sk_test_...` in `.env`. Live keys are rejected. Hosted Checkout does not require a publishable key.
2. Run `stripe login`, then forward events using the Stripe CLI:

   ```sh
   stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded --forward-to http://localhost:4022/api/stripe/webhook
   ```

3. Copy the listener's `whsec_...` secret into `STRIPE_WEBHOOK_SECRET` in `.env` and restart `pnpm dev`. Keep the listener running. `WEB_ORIGIN` must match the browser origin (default `http://localhost:4020`); Checkout returns there.
4. Choose **FIAT**, enter an amount, and continue to Stripe. Use `4242 4242 4242 4242`, any future expiry and any three-digit CVC. Use `4000 0000 0000 0002` to test a decline. Test cards and authentication scenarios are listed in [Stripe's testing guide](https://docs.stripe.com/testing).
5. After successful checkout, the Activity page confirms funding and refreshes the account balance. If Stellar forwarding is temporarily unavailable, use **Retry confirmation** or let Stripe retry the webhook. Keep the same funding request ID when retrying checkout creation.

Stripe configuration is required for FIAT. Testnet funding works without Stripe credentials. For a hosted deployment, register the HTTPS `/api/stripe/webhook` endpoint in the same Stripe sandbox and use its signing secret instead of the CLI listener secret.

## Mandates and third-party payments

There is one mandate flow for all accounts. A mandate grants a person or
agent spending access to an existing Smart Account's USD balance.
Creating one does not open an account or create another balance. No source-account selection is needed.

1. Open **Mandates**. New mandates automatically use your main account.
2. Enter the holder, USD limit, rolling period and expiry. Optionally type seller IDs separated by commas or spaces (for example, `101, 202, 303`).
3. Use **Show mandate** to reveal and save the secret mandate ID. The Pay link is simply `/pay`.

Every new mandate installs an on-chain signer and an asset-scoped contract rule,
with a rolling spending limit, ledger expiry and verified-recipient policy.
The API also checks wall-clock expiry. Several mandates can share an account,
each with its own allowance. A USD mandate cannot authorize an XLM transfer.
Revocation disables the secret ID immediately; pending on-chain revocation remains
visible and retryable until the rule is removed.

Each account has a stable numeric seller ID kept internally and assigned
automatically to existing accounts. A mandate accepts up to 100 positive whole-number
seller IDs; duplicates are removed. An empty list allows any verified seller.
Creation validates only the list format, so sellers need not exist or be verified yet.
At payment preview and submission, the service matches the actual destination address
to its seller ID and enforces the list. Seller verification is still required at payment
time and enforced on chain; the numeric seller list is enforced by the payment service.
The API accepts the optional field as `sellerIds: [101, 202, 303]`.

The holder opens `/pay` without an owner login, enters the secret mandate ID, their registered agent identification and
the seller's Smart Account C address copied from their dashboard, then checks and
submits the payment. The mandate determines the buyer's source account and currency;
there is no payment-method selector. The recipient's display name does not establish verification.

The secret mandate ID is a bearer credential; the public agent ID identifies the paying agent and must be registered to the source account. It never appears in links or receipts.
The Pay page always masks it. The owner's dashboard reveals it only after
**Show mandate**, and clears it after **Hide mandate**. **Copy mandate ID** retrieves
the secret through the owner-authenticated endpoint and copies it without revealing
it in the field. Copy buttons work while masked or visible.
Invalid IDs, unverified recipients, limits, expiry, revocation and insufficient
funds decline payment. Unchanged retries reuse their request ID. Pending blockchain
transactions are reported as pending until confirmed.

Existing users keep their first account as their main account, and users without an account receive one automatically on login or workspace load. Historical accounts, mandates and funds are retained; no balances are combined or moved.

Existing local traditional accounts are upgraded when their workspace loads:
their old demo balances are issued exactly once into testnet USD, with recovery
across restarts. Old service-only mandates are retained as revoked records and must
be recreated. Existing XLM remains on chain and is not displayed as USD.

## Seller verification

Stellar verification uses **an on-chain registry entry keyed by the exact recipient
Smart Account C address**. A valid address or seller display name alone does not
establish verification.

During automatic account setup, the service checks that the deployed contract responds
to `get_context_rule(0)`. The registry administrator then calls
`register(C_address, "workspace/<account-id>")`. The registry stores that address,
metadata and verification ledger. Only its administrator can register or revoke entries.

Before payment, the API calls `is_verified(C_address)`. The sender's payment policy
checks that same registry during on-chain authorization. A mandate additionally
checks its spending limit. Revoking a recipient's registry entry blocks later payments.

The prototype automatically attests accounts it provisions. It does not perform KYC,
business verification or domain-ownership verification. All accounts use
this same registry verification.

## Configuration and storage

[.env.example](.env.example) lists all supported settings. Never commit `.env`.

| Setting | Purpose |
|---|---|
| `PAYMENTS_CHAIN_DB` | Workspace, encrypted custody vault and transaction journal; defaults to `workspace.sqlite` in the API directory |
| `PAYMENTS_ENCRYPTION_KEY` | 32-byte hex custody key generated by `setup:payments` |
| `PAYMENTS_RPC_URL` | Stellar testnet RPC endpoint |
| `PAYMENTS_HORIZON_URL` | Testnet account activation lookup |
| `PAYMENTS_FRIENDBOT_URL` | Testnet activation and funding provider |
| `PAYMENTS_EXPLORER_URL` | Base URL for account and transaction links |
| `SMART_ACCOUNT_WASM_HASH` | Uploaded account code used to deploy each Smart contract |
| `ED25519_VERIFIER_ID` | Contract verifying account and mandate signatures |
| `SPENDING_LIMIT_POLICY_ID` | On-chain mandate spending limits |
| `AGENT_REGISTRY_ID` | Account-scoped on-chain agent identification registry |
| `AGENT_VERIFIER_ID` | Mandate signature verifier requiring registered agent identification |
| `SELLER_REGISTRY_ID` | Verified recipient registry |
| `PAYMENTS_VERIFIED_SMART_POLICY_ID` | Policy requiring verified C-address recipients |
| `PAYMENTS_REGISTRY_ADMIN_SECRET` | Testnet registry administrator key |
| `STELLAR_SOURCE` | Stellar CLI identity used by `setup:contracts`; defaults to `mandate-deployer` |
| `WEB_ORIGIN` | Allowed browser origin; defaults to `http://localhost:4020` |
| `STRIPE_SECRET_KEY` | Stripe sandbox/test secret key (`sk_test_...`); live keys are rejected |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (`whsec_...`) for `/api/stripe/webhook` |
| `RECEIPTS_PORT` | Payments API port; defaults to `4022` |
| `NODE_ENV` | Set to `production` for Secure session cookies; requires HTTPS |

Signing keys, secret mandate IDs and cached command responses are encrypted with
AES-256-GCM. Passwords use salted scrypt hashes; sessions and mandate IDs are
authenticated by their hashes. Ordinary workspace, preview and payment responses
exclude the secret ID. Records and receipts use a separate non-secret `reference`
for management and auditing. The on-chain rule ID and signing mechanism are unchanged.
Stellar envelopes persist before
broadcast and retain their original transaction IDs on retries.

Keep the encryption key with its database. Changing keys or contract configuration
requires a separate database. The current application opens only its current
workspace schema and does not migrate other database layouts.

## API

| Route | Purpose |
|---|---|
| `POST /api/auth/register`, `/api/auth/login`, `/api/auth/logout` | Email/password sessions |
| `GET /api/workspace` | Main account, agents, mandates and activity |
| `POST /api/agents` | Register an agent on chain with a name and request ID |
| `POST /api/accounts/open` | Legacy compatibility: returns the existing main account; never opens an additional account |
| `POST /api/accounts/:id/funding` | Funding with amount and request ID; `method: "fiat"` (default) returns HTTP 201 with `{ status: "checkout", provider: "stripe", mode: "test", sessionId, url }`; `"testnet"` returns HTTP 201 with a confirmed funding receipt |
| `GET /api/funding/stripe/:sessionId` | Owner-authenticated Stripe confirmation; returns `paid` with a funding receipt, `pending`, or `expired` |
| `POST /api/stripe/webhook` | Raw-body Stripe webhook with a verified `Stripe-Signature`; completes paid sandbox funding idempotently |
| `POST /api/mandates` | Create a mandate on the main account; `accountId` is optional for older clients |
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
use an owner cookie or a separate Authorization Bearer token. Agent identification is also required as `agentId`. The owner-authenticated
creation response is `{ mandate, mandateId }`; its `mandate.reference` is not a
payment authorization. Secrets are never put in links, receipts or on-chain arguments.

## LangChain module

[`packages/langchain`](packages/langchain/README.md) provides a standalone
LangChain payment agent and direct CLI. Run `pnpm agent:langchain` to type a
payment prompt containing a mandate ID, agent identification, seller Smart Account address and USD
amount. The agent uses Google's `gemini-3.8-flash` by default; set `GEMINI_API_KEY`
and optionally `GEMINI_MODEL` in `.env`. The direct `pnpm pay:langchain` command
uses explicit arguments and needs no model. Both call `/api/pay` with a stable
request ID; see the module README for configuration, retries and import examples.

For a chat-box UI, run `pnpm dev` and open `http://localhost:4020/chat`
(or click **Chat** in the dashboard). The UI uses the same agent, supports
follow-up questions, and shows the payment result. Gemini runs on the API server;
the API key stays in `.env`.
New users receive a registered **Chat agent** and **Chat mandate** during signup.
The mandate allows **1 USD per rolling 24 hours** and expires after 30 days.
Signed-in chats use both automatically, so payment prompts only need the seller
address and amount. Existing users receive these defaults when loading the
dashboard, signing in, or starting a signed-in chat. Creating a mandate grants access to the account's
existing balance; fund the main account before paying.

The create-mandate form has an optional **Mandate user** dropdown listing the
account's agents. Leaving it empty labels the mandate **Any registered agent**.
This is a user label; any registered agent on the source account can use
the mandate. Revoked or expired default mandates are never recreated on login.

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

To verify real contract deployment, automatic demo USD funding, Smart-to-Smart
payments, mandate limits and revocation with fresh wallets and testnet funds:

```bash
pnpm test:chain
```

Historical local-demo USD anchor and unified mandate verification receipts are in
[unified-mandate-verification.json](docs/unified-mandate-verification.json).
Earlier XLM-only verification receipts are in
[stellar-account-verification.json](docs/stellar-account-verification.json).
Verification of payments using the previous secret-only payment flow is in
[secret-mandate-verification.json](docs/secret-mandate-verification.json).
FIAT funding requires a confirmed Stripe sandbox payment; Testnet funding issues demo USD directly. All payment settlement uses Stellar testnet only.

Deployed agent-registry and mandate-verifier checks, including a successful identified agent payment and refusal of unknown or foreign account identities, are recorded in [agent-identity-verification.json](docs/agent-identity-verification.json).


## iPhone app

The native app from `main` lives in `apps/ios/Mandate.xcodeproj` and uses the same Mandate terminology as the web dashboard. Open it in Xcode with the iOS SDK required by the project, start `pnpm dev`, and run it in the iPhone simulator. Sign in with your workspace email and password; the default API address is `http://localhost:4022`. The app reads `/api/workspace`, creates mandates and revokes them by their record reference. It uses session cookies and converts USD amounts for the native views.

Mandate payments require both the secret mandate ID and an on-chain registered agent identification; use the web Pay page or the LangChain client. The native detail sheet can reveal the mandate ID after owner sign-in. Native build verification requires macOS and Xcode.
