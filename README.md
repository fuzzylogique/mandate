# Mandate

Shoppers that buy for you on their own, inside rules your account enforces on Stellar.

You give a shopper a sentence: *"Keep herbs stocked. Spend up to $10 every week
at trusted stores only."* From then on it works without you. It compares the
stores it may use, buys from the cheapest trusted one, and leaves a receipt that
says why it chose that store. You hear from it only when something is outside
your rules: a store that isn't trusted, or a price over its limit. Then you get a
request with three answers: **Allow once**, **Raise the limit**, or **No**.

The rules aren't a setting in our app. Each customer's money sits in a Stellar
smart account, and each shopper signs with its own key under its own rule on
that account. A spending-limit policy and a trusted-store policy check every
payment, so a shopper (or a bug in our service) can't pay past them.

Built for the Blockchain Innovation Challenge powered by Stellar (Problem Space 2,
Verification Infrastructure).

## Who shops

| Shopper | Who runs it | How it pays |
|---|---|---|
| **Mandate shops for you** | Our service, on a schedule ("keep herbs stocked, weekly"). | Its own key, kept encrypted by the service, signing under its rule. |
| **Your AI assistant** | Claude, or any assistant that speaks MCP. You give it a one-time code. | It makes its own key and holds it. The service never sees it. |
| **Someone you trust** | A person on your team or in your household. | They sign in and buy. Their rule on your account decides. |

## How it works

```
You ──sentence + limit──► Smart account (one per customer, holds demo dollars)
                           ├─ rule 0: you
                           └─ rule n: one per shopper, with that shopper's key
                                ├─ spending-limit policy (per day, week or month)
                                └─ trusted-store policy ──► store registry

Shopper ──find offers──► compares stores ──x402──► signs one transfer under its rule
                                                     └─► facilitator settles on Stellar
Blocked? ──► "Needs you": allow once (you pay, under rule 0) · raise the limit · no

Service ◄── PaymentAuthorized events + notes ("cheapest of 2 trusted stores") ──► web and iPhone apps
```

On-chain: who may spend, how much, to whom, and proof each payment passed
those checks. Off-chain: names, what was bought, why a store was picked.

Payments go over [x402](https://developers.stellar.org/docs/build/agentic-payments/x402),
the HTTP payment protocol: a store answers `402 Payment Required`, the shopper
signs and retries. Stores that don't take x402 are on the roadmap (a card rail
for the same rules).

## Layout

| Path | What it is |
|---|---|
| `contracts/account` | The smart account. Adapted from OpenZeppelin's multisig example. |
| `contracts/ed25519-verifier` | Checks shopper and owner signatures. OpenZeppelin wrapper. |
| `contracts/spending-limit-policy` | Cap per rolling window. OpenZeppelin wrapper. |
| `contracts/seller-registry` | Trusted stores and their domains. Ours. |
| `contracts/verified-seller-policy` | Rejects payments to stores not in the registry; emits the receipt event. Ours. |
| `apps/receipts` | The Mandate service: sign-in, accounts, shoppers and their jobs, approval requests, the agent API, receipts. Its Stellar layer (encrypted key vault, command journal, idempotent submits) is Jacob's. |
| `apps/merchant` | Three demo stores selling over x402: FreshMart and GreenLeaf (trusted) and FreshMarrt (a look-alike, not trusted). Fixtures, not the product. |
| `apps/facilitator` | Our own x402 facilitator. Needed for smart-account payments (see below). |
| `apps/agent` | The connector for AI assistants: an MCP server and a CLI. Holds the assistant's own key. |
| `apps/web` | The owner's web app. |
| `apps/ios` | The owner's iPhone app (SwiftUI), the same account. |
| `packages/shared` | Types shared by the TypeScript packages, and the smart-account x402 signer. |
| `scripts/` | Testnet setup and contract deployment. |

## Status

Checked end to end on Stellar testnet on Nov 15:

| Flow | State |
|---|---|
| Sign up, open an account, add money | Works. Opening deploys the customer's own smart account (about 10 s). |
| Hosted shopper keeps an item stocked | Works. Compares trusted stores, buys the cheapest, writes why. |
| Look-alike store | Blocked on-chain. Shows as "Needs you" with the store it imitates. |
| Over the limit | Blocked on-chain. Allow once (you pay) and raise the limit (changed on-chain, then the shopper buys) both work. |
| AI assistant over MCP | Works with Claude Code: connect with a code, check budget, find products, buy, check a request. |
| Shared spending | Works. The person signs in and buys; their limit and the trusted-store rule apply. |
| Stop a shopper | Works. Its rule is removed from the account; it can't pay after. |
| Seller verification against `stellar.toml` | Not started; stores are registered by setup. |
| Stores without x402 | Not started (card rail). |

### Deployed on testnet

| Contract | Id |
|---|---|
| Trusted-store policy | `CBNGZVLAVZWXG6XGHDLOWPGLZA3FPZSSH5GU3KJZTFGG2ZZUQ33CBFGV` |
| Store registry | `CCGJDOFMPUARLPQN43PINZMV2VDLXTLPOCGJ7SYIVYJHWHMTLO7FG57C` |
| Spending-limit policy | `CAMLQKBJZBLW2XMWWUSA66PCIJ6UMROY57FFVIIV4WWXZQEQLQRXH5XN` |
| ed25519 verifier | `CAERXSDPAVY6H53I4UYMUUBMFVHJYZPULMUYCBTLDHTZTWJJCHNZBGNU` |
| Demo-dollar token | `CAOXAIBVHPDEF2ENG64TDBPO2232B74HPQF5KRSVU3IHENSYCYT3B67O` |

Smart accounts are deployed per customer from wasm hash
`04ca584b40766568b33d981f4f95c1061d304c0e25d45b7217cba006d7ba40e0`.

## Quick start

Needs Node 24+, pnpm, and the [Stellar CLI](https://developers.stellar.org/docs/tools/cli)
with a funded `mandate-deployer` identity.

```bash
pnpm install
```

```bash
pnpm setup:testnet
```

```bash
scripts/deploy-contracts.sh
```

Put the printed contract ids in `.env` (skip this and the step above to reuse
the deployed contracts listed above: copy their ids into `.env`).

```bash
pnpm setup:demo
```

That makes the vault key, uploads the smart-account code, creates the demo
dollar, and sets up the three stores. It is safe to run again.

In four terminals:

```bash
pnpm dev:facilitator
```

```bash
pnpm dev:merchant
```

```bash
pnpm dev:receipts
```

```bash
pnpm dev:web
```

Open http://localhost:4020, create a login, open your account and add money.
Then add a shopper. To see the rules hold, open a shopper's **Test the rules**
menu: it really tries to pay the look-alike store, or to buy something over its
limit, and the account blocks it.

In the apps, the people-facing words differ from the code on purpose: an agent
is a **shopper**, a mandate is a shopper's **rule**, a verified seller is a
**trusted store**, a refused payment is **blocked**, and revoking a mandate is
**stopping** a shopper.

### Connect your AI assistant

Add a shopper of kind **Your AI assistant** in the app. It shows a one-time code.
Then, from the repository root:

```bash
claude mcp add mandate -- node apps/agent/src/mcp.ts
```

Ask Claude: *"Connect to Mandate with code ABCD-EFGH."* It makes its own key,
stores it in `~/.mandate/agent.json`, and the service adds a rule for that key to
your account. After that, ask it to buy things. Its tools are `check_budget`,
`find_products`, `buy` and `check_request`.

The same from a terminal:

```bash
pnpm agent connect ABCD-EFGH
```

```bash
pnpm agent find herbs
```

```bash
pnpm agent buy greenleaf/herbs
```

### iPhone app

Needs Xcode 26 or later. With the services above running:

```bash
open apps/ios/Mandate.xcodeproj
```

Pick an iPhone simulator and press Run. The simulator reaches the API at
`http://localhost:4022` with no setup. On a real iPhone, set your team under
Signing & Capabilities, then set the service address on the sign-in screen to
your Mac's address on the same network (for example `http://192.168.1.20:4022`).

Adding a shopper asks for Face ID or the passcode. In the simulator, turn it on
with Features › Face ID › Enrolled, then Features › Face ID › Matching Face when
prompted.

## Demo shortcuts to know about

- **The service keeps the owner's key.** Each customer's owner key sits in the
  service's encrypted vault, so "Allow once" and "Raise the limit" are one tap.
  A real deployment signs those on the owner's phone with a passkey.
- **Hosted shoppers' keys are in the vault too.** That's what lets them run on a
  schedule. Assistants hold their own keys; the service never sees those.
- **Demo dollars.** A Stellar asset we issue, not USDC: the USDC faucet needs a
  captcha. "Add money" mints demo dollars into the account.
- **Face ID guards the app, not the key.** See the first point.

When a payment is blocked, the network only says "not authorized". The reason
shown ("Over its $10 weekly limit", "Not a trusted store") is worked out by the
service from the shopper's rule and the store registry.

## What we learned about x402 and smart accounts

Hosted x402 facilitators do not settle payments from a smart account that has
policies. Tested against `https://x402.org/facilitator`:

- **Fee ceiling.** The stock facilitator sponsors at most 50,000 stroops
  (0.005 XLM) per payment. A mandate payment runs the signature verifier and two
  policies on-chain and costs about 525,000 stroops (0.05 XLM).
- **Event check.** The stock facilitator requires a payment to emit exactly one
  contract event, the token transfer. Our policies emit two more.

`apps/facilitator` is the stock facilitator code with a higher ceiling and with
events from our two policy contracts ignored. The second change overrides a
private method of `@x402/stellar`, so that package is pinned to an exact version.

Other things worth knowing:

- The stock x402 client can't sign for a smart account. `apps/agent/src/smart-account-scheme.ts`
  replaces its signing step; the signing logic lives in `packages/shared/src/smart-account.ts`.
- When a policy rejects a payment, the network reports a generic
  `Error(Auth, InvalidAction)`, not which rule failed.
- The Stellar CLI reads `.env` files in parent directories. A variable named
  `STELLAR_RPC_URL` there breaks CLI commands, which is why ours is `RPC_URL`.
- The x402 client has its own spending caps, but they run inside the agent's
  process. Ours are enforced by the account on-chain, whatever the agent runs.

## Credits

The service's Stellar layer (encrypted key vault, command journal, idempotent
transaction submission, workspace store) is by Jacob Abraham.
Smart account, verifier and spending-limit code come from
[OpenZeppelin Stellar Contracts](https://github.com/OpenZeppelin/stellar-contracts) (MIT).
Payments use [x402](https://developers.stellar.org/docs/build/agentic-payments/x402).
