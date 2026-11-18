# Mandate

Purchasing agents for teams, inside rules the agents cannot break.

A team at a mid-sized company sets up a **purchasing workflow** in a minute: what an agent buys (software renewals, office supplies, cloud and API usage), which vendors it may use, and its budget. The agent connects with its own key. Every payment it makes is checked by Stellar smart contracts against that budget and vendor list, and leaves a receipt the finance team can export.

- **Workflows**: pick a template, choose approved vendors by name, set a budget. You get a one-time code and ready-made instructions for the agent.
- **One sign-in per agent**: each agent makes its own key, registered on chain. Nobody else can pay as it, including Mandate.
- **No approval requests**: an agent cannot ask for more. Only the signed-in owner can change a budget, and the change is written to Stellar.
- **Spending**: totals by workflow and vendor, every refused attempt with the reason, receipts read from chain events and a CSV export.

The dashboard shows the team's account and USD balance at the top, followed by **Workflows**, **Agents**, **Mandates** and **Spending**. Signup provisions a private Classic wallet and a verified Smart Account automatically. Choose **FIAT** or **Testnet** when adding funds.

## Built on open source

Mandate is MIT licensed ([LICENSE](LICENSE)) and stands on open-source Stellar work:

| Piece | What we use it for |
|---|---|
| [OpenZeppelin Stellar contracts](https://github.com/OpenZeppelin/stellar-contracts) (`stellar-accounts`, MIT) | The smart account, context rules, the spending-limit policy and the Ed25519 verifier. Our account, spending-limit policy and verifier contracts are thin wrappers over it |
| [x402](https://github.com/x402-foundation/x402) (`@x402/stellar`, `@x402/express`, `@x402/fetch`, Apache-2.0) | Agent purchases over HTTP, and the base of our facilitator |
| [Stellar SDK](https://github.com/stellar/js-stellar-sdk) and the Stellar CLI | Transactions, simulation and contract deployment |
| [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) and [LangChain](https://github.com/langchain-ai/langchainjs) | How agents connect |

What we add on top is in [contracts](contracts): an agent registry and agent verifier (one key per agent, bound on chain), a seller registry and a verified-seller policy (a mandate can only pay verified sellers, optionally a fixed list).

**The facilitator is open too.** Stock x402 facilitators reject payments from smart accounts that run policies. [apps/facilitator](apps/facilitator) is the stock one with that fixed, open on testnet at `https://mandate.fly.dev:4023`, and [docs/upstream](docs/upstream) has the same fix as a patch for `@x402/stellar`.

## Deployed on Stellar Testnet

| Contract | ID |
|---|---|
| Agent registry | [`CAUNHENIZIUTRJ57GCZ2BY7OM6VIQLIF7GA5DBYAJHJ5WLSV5ETKOGHH`](https://stellar.expert/explorer/testnet/contract/CAUNHENIZIUTRJ57GCZ2BY7OM6VIQLIF7GA5DBYAJHJ5WLSV5ETKOGHH) |
| Agent verifier | [`CAWQMKRQXVOU4IEK4LB4T5SZBGWKD7AN4WTUZJANEUTPJSHMG2JUCV7W`](https://stellar.expert/explorer/testnet/contract/CAWQMKRQXVOU4IEK4LB4T5SZBGWKD7AN4WTUZJANEUTPJSHMG2JUCV7W) |
| Spending-limit policy | [`CAVIDSIO5AX65326A4KEZMAOSJXNRIRLNKKQTSGJU2F4DF43GKKNUOJT`](https://stellar.expert/explorer/testnet/contract/CAVIDSIO5AX65326A4KEZMAOSJXNRIRLNKKQTSGJU2F4DF43GKKNUOJT) |
| Seller registry | [`CDOMOPTBJPOSFJMPYHI5G7HJC6QFRAPDWKFISGNENJGSKB2PZOA7J3BO`](https://stellar.expert/explorer/testnet/contract/CDOMOPTBJPOSFJMPYHI5G7HJC6QFRAPDWKFISGNENJGSKB2PZOA7J3BO) |
| Verified-seller policy | [`CBR4M66YAZTBATCMGPOTYE2T5WAU6MKURKMOGF6VWSFCS757VPX6L2FZ`](https://stellar.expert/explorer/testnet/contract/CBR4M66YAZTBATCMGPOTYE2T5WAU6MKURKMOGF6VWSFCS757VPX6L2FZ) |
| Owner signature verifier (Ed25519) | [`CBWYAZ7NASNMIL7DIQKD2R4UITMCXHAEVJQHYXHPSGYM6ECOLRDLVPMH`](https://stellar.expert/explorer/testnet/contract/CBWYAZ7NASNMIL7DIQKD2R4UITMCXHAEVJQHYXHPSGYM6ECOLRDLVPMH) |
| Demo USD (Stellar Asset Contract) | [`CAF5YGTPPQFX3EYSEYTBI46CASCALCNPGQK3HYFQSPCBZVQKETQCMTJQ`](https://stellar.expert/explorer/testnet/contract/CAF5YGTPPQFX3EYSEYTBI46CASCALCNPGQK3HYFQSPCBZVQKETQCMTJQ) |

Every user's smart account is deployed from the account WASM with hash
`04ca584b40766568b33d981f4f95c1061d304c0e25d45b7217cba006d7ba40e0`.

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

## Hosted demo

Live at **https://mandate.fly.dev**. One always-on Fly.io machine runs the
dashboard, the API, the demo vendors (`https://mandate.fly.dev:4021`, the
`STORES_URL` agents receive) and the x402 facilitator
(`https://mandate.fly.dev:4023`, open and rate limited). The
database lives on the `mandate_data` volume at `/data/agent-keys.sqlite`.
Settings that differ from local dev are in [fly.toml](fly.toml). Everything
else in `.env` is stored with `fly secrets`.

```bash
fly deploy --ha=false
```

To replace the hosted database with a local one, copy it to
`/data/import.sqlite` and restart. [scripts/fly-start.sh](scripts/fly-start.sh)
moves it into place before anything opens it.

```bash
sqlite3 apps/receipts/agent-keys.sqlite ".backup import.sqlite"
```

```bash
echo "put import.sqlite /data/import.sqlite" | fly ssh sftp shell
```

```bash
fly apps restart mandate
```

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

The **Spending** tab totals agent purchases over the last 30 days by workflow and
by vendor, lists every attempt the account refused with the reason, and shows
confirmed funding and payment transactions with explorer links. **Export CSV**
downloads purchases and refusals for finance. Older local demo receipts remain
marked as historical simulated activity.
The dashboard refreshes when returning to its tab and every 15 seconds.
Payments back to the source account are rejected.

## Purchasing workflows

**Workflows → New purchasing workflow** is where a team that has never run a purchasing agent starts:

1. **Pick a template**: Software renewals, Office supplies, Cloud and API usage, or a blank one.
2. **Choose vendors and a budget.** Vendors are picked by name from the directory of verified sellers; the ones that sell that kind of thing start selected. Set the budget, its window (24 hours, 7 days or 30 days) and an end date.
3. **Hand the agent its code.** The dashboard shows a one-time code, the command that adds Mandate to Claude, and instructions to paste into the agent: its job, how to check its budget, and to stop and report if a purchase is declined.

A workflow is an agent with its own key plus a mandate. The mandate is drafted in step 2 and goes on Stellar the moment the agent connects, because its only signer is the key the agent makes for itself. If that step fails, the next dashboard load retries it.

Each workflow card shows what is left of the budget, its vendors, its last purchase and how many attempts were refused. **Change budget** rewrites the limit in the spending-limit policy on Stellar. Only the signed-in owner can do this; agents have no route to ask.

The company and team are set at signup or with **Edit team**. Accounts are listed in the vendor directory only if they choose to be (`PATCH /api/profile` with a `vendor` name and category).

## Agents and on-chain identification

The **Agents** tab lists every agent associated with your main account. **Add agent** adds one that holds its own key: for Claude over MCP, LangChain agents and scripts. It connects with a one-time code; see [Agents with their own key](#agents-with-their-own-key-mcp-langchain-x402).

**Other ways to connect** in that dialog offers the older kind, an agent **with a mandate ID**: it registers a name and a stable public identification value (`agt_…`) right away, and pays on the Pay page or in chat with a secret mandate ID that the service signs for. Any agent of this kind can use any of the account's secret-ID mandates.

Agents have no balance or spending limits of their own. **Remove agent** deletes its registry entry on chain and revokes every mandate it holds.

The service attests `(Smart Account C address, agent ID)` in an administrator-controlled agent registry, following the seller-verification pattern. Registrations appear only after chain confirmation, and the dashboard checks their current on-chain status. Agent names are display labels; the registry entry determines membership. Identification is public and is not a separate bearer secret or proof of legal identity.

Payments require both the secret `mandateId` and the registered `agentId`. The mandate verifier checks the on-chain registry during Smart Account authorization. The mandate signature binds the agent ID to the account, rule and payment digest, and emits an on-chain agent authorization event. Foreign, missing, unknown or revoked identities cannot authorize a mandate payment. The API records `agentId` in activity and receipts. Existing mandate rules are upgraded before payment by replacing the old signer with the agent-aware verifier; their limits and spending history remain intact.

Run `pnpm setup:contracts` for an existing checkout to deploy the agent registry and verifier and save their IDs. Existing agents are never inferred from mandate-holder names.

## Agents with their own key (MCP, LangChain, x402)

An agent that holds its own key can pay only under the mandates you give it, and Mandate cannot pay as it. There are no approval requests: an agent cannot ask for more, and nothing it does can raise a limit or add a seller. A workflow does steps 1 and 3 for you; this is the same thing by hand.

1. **Agents → Add agent.** The dashboard shows a one-time code (like `K7Q4-92XD`, valid 30 minutes, usable once). Nothing is registered yet.
2. **Connect the agent.** For Claude Code: `claude mcp add mandate -- node apps/agent/src/mcp.ts`, then ask it to "connect to Mandate with code K7Q4-92XD". The agent creates an ed25519 key in `~/.mandate/agent.json` (mode 600) and signs the connect request with it. Mandate then registers `(account, agent ID) → public key` in the on-chain agent registry. From then on, the registry accepts only that key for this agent.
3. **Mandates → New mandate**, and choose the agent as **Mandate user**. Its key becomes the rule's **only signer**: there is no secret mandate ID, Mandate holds no key for it, and the Pay page and `/api/payments` refuse it. The seller ID list is resolved to addresses and written into the rule on chain, so every listed ID must already belong to a Mandate account.
4. **The agent pays.** Each request to Mandate is signed with its key (`x-mandate-agent`, `x-mandate-time`, `x-mandate-signature` over method, path, time and body hash; signatures expire after 5 minutes).
   - **Direct payment** (`pay_seller`): Mandate checks the seller, limit, list, balance and expiry, then builds the transfer and returns the unsigned authorization. The agent decodes it and refuses to sign anything except `transfer(account, seller, amount)` on the USD token. It signs and returns it, and Mandate submits it and pays the network fee.
   - **x402** (`find_products`, `buy`): the agent pays a vendor directly, signing the x402 payment itself, and the vendor's facilitator submits it. The agent then reports the purchase with a one-line reason, and Mandate records it only after reading the confirmed transfer from chain: from this account, in USD, to a verified seller. If the account refuses the payment, the agent reports the attempt and Mandate works out the reason itself, so the owner sees it under **Spending**.

**Receipts come from the chain, not from the agent.** The verified-seller policy emits a `PaymentAuthorized` event for every mandate payment, whoever submitted it. The API reads those events every few seconds and records any payment it does not already have, so an agent that pays a store and never reports it still leaves a receipt. The agent's report only adds the description. Refusals never reach the chain, so those are still reported by the agent.

Every payment is checked again by the owner's smart account on Stellar, whether or not it went through Mandate: the agent verifier (signature, plus the registered key for this agent), the spending-limit policy, and the verified-seller policy (verified C address, and the mandate's seller list if it has one). So an agent that skips Mandate, uses x402, or tries another key still cannot overspend, pay an unverified or unlisted seller, or pay after you remove it. `pnpm test:agents` proves each of these on testnet.

The same agent works three ways, all from [`apps/agent`](apps/agent):

| Use | How |
|---|---|
| MCP (Claude and other assistants) | `claude mcp add mandate -- node apps/agent/src/mcp.ts`: tools `connect_to_mandate`, `check_mandates`, `check_seller`, `pay_seller`, `find_products`, `buy` |
| LangChain | `import { createMandateTools } from "@mandate/agent/langchain"`: the same tools as LangChain tools |
| Command line | `pnpm agent connect <code>`, `mandates`, `seller <address>`, `pay <seller> <amount> [reference]`, `find <words>`, `buy <url>` |

Set `MANDATE_API_URL` (default `http://localhost:4022`) and `MANDATE_AGENT_FILE` to change where the agent connects and keeps its key.

**x402 demo.** `pnpm setup:stores` (with `pnpm dev` running) opens three vendor accounts in Mandate, Seatwise (software seats), Paperline Supply (office supplies) and Cloudhaven (cloud and APIs), so their smart accounts are verified sellers, and lists them in the vendor directory. It also picks an unregistered look-alike address (Paperline Suply) and funds a facilitator key. `pnpm dev` then also serves the vendors on port 4021 (`/catalog` is free; each item is paid over x402 to the vendor's C address) and the facilitator on 4023. The vendors are defined in [apps/merchant/src/vendors.ts](apps/merchant/src/vendors.ts).

**Pitch demo.** `pnpm stage:demo` (after `pnpm setup:stores`, with everything running) signs up Dana Okafor, who runs Operations at Larkfield Logistics, with $5,000 of testnet USD. It sets up two workflows the way the dashboard does, Software renewals ($300 every 30 days, Seatwise only) and Office supplies ($200 every 7 days, Paperline Supply only), connects an agent with its own key to each, makes six x402 purchases and three attempts the account refuses: the cheaper look-alike vendor, a purchase over the budget, and a vendor not on the list. The login is a test value kept in `.env` as `DEMO_OWNER_PASSWORD`. Running it again reuses everything; pass `--again` to make more purchases.

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
automatically to existing accounts. (For a mandate held by an agent with its own key,
the list is enforced on chain instead; see above.) A mandate accepts up to 100 positive whole-number
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
| `STORES_URL` | x402 demo vendors that connected agents can browse; defaults to `http://localhost:4021` |
| `MERCHANT_PORT`, `FACILITATOR_PORT`, `FACILITATOR_URL` | Ports for the demo vendors and facilitator |
| `FACILITATOR_HOST` | Set to `0.0.0.0` to open the facilitator to other machines; see [apps/facilitator](apps/facilitator) for its other settings |
| `MERCHANT_ASSET`, `STORE_*_ADDRESS`, `STORE_*_PASSWORD`, `FACILITATOR_SECRET` | Written by `setup:stores`: the USD token, vendor accounts (test logins for the demo), the look-alike address and the facilitator's fee-paying key |
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
| `GET /api/workspace` | Main account, agents, mandates, activity, refused payments and the vendor directory |
| `PATCH /api/profile` | Company and team for the workspace; `vendor: { name, category }` lists the account in the vendor directory, `vendor: null` removes it |
| `POST /api/workflows` | A purchasing workflow: adds an agent that will bring its own key and drafts its mandate (`name`, `category`, `limit`, `period`, `expiresAt`, `sellerIds`), granted on chain when the agent connects |
| `PATCH /api/mandates/:id` | Owner only: change a mandate's `limit` (rewritten in the spending-limit policy on Stellar) or `category` |
| `POST /api/agents` | Register an agent on chain with a name and request ID; with `connect: true`, add an agent that will bring its own key and return its one-time code |
| `POST /api/agents/:id/pairing` | New one-time code for an agent still waiting to connect |
| `DELETE /api/agents/:id` | Remove an agent from the registry and revoke its mandates |
| `POST /api/agent/connect` | Agent-signed: redeem the code and register the agent's key on chain |
| `GET /api/agent/me`, `/api/agent/mandates`, `/api/agent/sellers/:address` | Agent-signed: connection details, its mandates, seller verification |
| `POST /api/agent/payments/prepare`, `/api/agent/payments/submit` | Agent-signed: build a transfer for the agent to sign, then submit it |
| `POST /api/agent/x402` | Agent-signed: record an x402 purchase after reading it from chain |
| `POST /api/agent/declines` | Agent-signed: report an x402 purchase the account refused; the reason is worked out by the service |
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

To verify agents with their own key on testnet, with `pnpm dev` running and after `pnpm setup:stores`
(it starts the stores and facilitator itself if they are not running):

```bash
pnpm test:agents
```

It connects an agent with a code, pays a store directly and over x402, and checks refusals: an allowed-but-unlisted seller, a look-alike, over the limit, another key posing as the agent, and a removed agent. The x402 refusals and both attempts that skip Mandate are refused by the account on chain. Receipts are in [agent-key-verification.json](docs/agent-key-verification.json).

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

The app's Agents screen adds agents with their own key (showing the one-time code), lists their status and removes them. Mandates for such agents show that only the agent's key can sign. Secret-ID mandate payments require both the secret mandate ID and an on-chain registered agent identification; use the web Pay page or the LangChain client. The native detail sheet can reveal the mandate ID after owner sign-in. Native build verification requires macOS and Xcode.

## License

[MIT](LICENSE).
