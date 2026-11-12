# Mandate

Spending rules and receipts for AI agents, enforced on Stellar.

An owner gives each agent a **mandate**: how much it may spend per period, which
verified sellers it may pay, and until when. The rules live in Soroban contracts
and are checked at payment time, so an over-limit payment or a payment to an
unverified seller fails on-chain no matter what the agent does. Every payment
that goes through becomes a receipt: agent, owner, seller, amount, transaction.

Built for the Blockchain Innovation Challenge powered by Stellar (Problem Space 2,
Verification Infrastructure). "Mandate" is a working name.

## How it works

```
Owner ──creates / revokes mandate──► Smart account (C-address, holds USDC)
                                      └─ rule: agent key, USDC transfers only, expiry
                                          ├─ spending-limit policy
                                          └─ verified-seller policy ──► seller registry

Agent ──request──► Seller API ──402──► agent signs one transfer ──► facilitator settles, pays fees

Receipt service ◄── PaymentAuthorized events + what the agent bought ──► dashboard, email
```

On-chain: who may spend, how much, to whom, and proof that a payment passed
those checks. Off-chain: what was bought, names, emails.

## Layout

| Path | What it is |
|---|---|
| `contracts/account` | The smart account. Adapted from OpenZeppelin's multisig example. |
| `contracts/ed25519-verifier` | Checks agent signatures. OpenZeppelin wrapper. |
| `contracts/spending-limit-policy` | Cap per rolling window. OpenZeppelin wrapper. |
| `contracts/seller-registry` | Verified seller accounts and their domains. Ours. |
| `contracts/verified-seller-policy` | Rejects payments to unregistered sellers; emits the receipt event. Ours. |
| `apps/merchant` | Demo seller: a paid API behind x402. A fixture, not the product. |
| `apps/agent` | Buyer agent: pays for a URL over x402, from its own account or from the smart account. |
| `apps/facilitator` | Our own x402 facilitator. Needed for smart-account payments (see below). |
| `apps/receipts` | Indexes payment events, stores receipts, serves them. |
| `apps/web` | Owner dashboard listing receipts. |
| `packages/shared` | Types shared by the TypeScript packages. |
| `scripts/` | Testnet setup, contract deployment, mandate creation, funding, direct transfer test. |

## Status

Verified on Stellar testnet on Nov 12, using testnet XLM's token contract as the
payment token (the USDC faucet needs a captcha, so USDC itself is untested):

| Piece | State |
|---|---|
| Contracts | Deployed. Unit tests pass (registry: 1, verified-seller policy: 4). |
| Owner creates a mandate | Works (`scripts/create-mandate.ts`, signed by the owner's key). |
| Agent pays a verified seller within its limit | Works, directly and through x402. |
| Agent pays an unverified recipient | Refused by the account's contracts. |
| Agent exceeds its limit | Refused by the account's contracts, directly and through x402. |
| Receipts | Each payment is indexed from chain into a receipt, with what was bought attached. |
| Dashboard | Builds and lists receipts; not yet looked at in a browser with real data. |
| Mandate management in the UI, owner sign-in, receipt email | Not started. |
| Seller verification against `stellar.toml` | Not started; sellers are registered by hand. |

### Deployed on testnet

| Contract | Id |
|---|---|
| Smart account (demo owner) | `CBZCTZ3SYFZ4FMI43HHMQMH26YWWPTL7N4INLJZ3UGYKHIEJLIZFWZ3X` |
| Verified-seller policy | `CBNGZVLAVZWXG6XGHDLOWPGLZA3FPZSSH5GU3KJZTFGG2ZZUQ33CBFGV` |
| Seller registry | `CCGJDOFMPUARLPQN43PINZMV2VDLXTLPOCGJ7SYIVYJHWHMTLO7FG57C` |
| Spending-limit policy | `CAMLQKBJZBLW2XMWWUSA66PCIJ6UMROY57FFVIIV4WWXZQEQLQRXH5XN` |
| ed25519 verifier | `CAERXSDPAVY6H53I4UYMUUBMFVHJYZPULMUYCBTLDHTZTWJJCHNZBGNU` |

Example x402 payment from the smart account:
[`a628cbc5…`](https://stellar.expert/explorer/testnet/tx/a628cbc5c0343413cf04be6200333f0b84149b6c46cb9a4ace16976166445ad6)

## Quick start

Needs Node 24+ and pnpm.

```bash
pnpm install
```

```bash
pnpm setup:testnet
```

That creates merchant, agent and owner test accounts with USDC trustlines and
writes them to `.env`. Then send testnet USDC to the `AGENT_ADDRESS` from
https://faucet.circle.com (choose Stellar testnet).

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

Then pay for something:

```bash
pnpm agent -- http://localhost:4021/weather
```

With `PAYER_MODE=classic` (the default) the agent pays from its own account and
no mandate is involved. Set `PAYER_MODE=smart-account` in `.env` to pay from the
smart account under the agent's mandate, once the contracts are deployed and a
mandate exists (next section).

To test without USDC, charge and pay in testnet XLM's token contract instead:
set both `MERCHANT_ASSET` and `AGENT_EXTRA_ASSET` to
`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` and pass the same
value as `--token` to the scripts below.

## Contracts

Needs Rust with the `wasm32v1-none` target and the Stellar CLI:

```bash
brew install rustup stellar-cli && rustup default stable && rustup target add wasm32v1-none
```

Homebrew's rustup is not put on your PATH automatically. Add this to `~/.zshrc`:

```bash
export PATH=/opt/homebrew/opt/rustup/bin:$PATH
```

```bash
cd contracts && cargo test && stellar contract build
```

If the build fails with `ld: ... tapi error: malformed file ... unknown architecture`,
the Command Line Tools are defaulting to a macOS SDK newer than their linker
understands. Point the build at the SDK that matches your macOS version, for example:

```bash
export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk
```

```bash
./scripts/deploy-contracts.sh
```

### Create a mandate

1. Deploy the owner's smart account. The owner's key goes on the default rule
   as an `External` signer (verifier contract + raw public key in hex):

   ```bash
   stellar contract deploy --network testnet --source mandate-deployer \
     --wasm contracts/target/wasm32v1-none/release/mandate_account.wasm \
     -- --name owner --policies '{}' \
     --signers '[{"External": ["<ED25519_VERIFIER_ID>", "<owner public key, hex>"]}]'
   ```

   Put the printed id in `.env` as `SMART_ACCOUNT_ID`.

2. Register the demo seller (the registry admin is the deployer identity):

   ```bash
   stellar contract invoke --network testnet --source mandate-deployer --id <SELLER_REGISTRY_ID> -- register --seller <MERCHANT_ADDRESS> --domain localhost:4021
   ```

3. Create the agent's mandate, signed by the owner. Defaults: USDC, limit 1 per day.

   ```bash
   node --env-file=.env scripts/create-mandate.ts --limit 5
   ```

   Put the printed rule id in `.env` as `AGENT_CONTEXT_RULE_ID`.

4. Move funds from the owner's classic account into the smart account:

   ```bash
   node --env-file=.env scripts/fund-smart-account.ts --amount 10
   ```

5. Try the rules directly, without x402:

   ```bash
   node --env-file=.env scripts/agent-transfer.ts --to <MERCHANT_ADDRESS> --amount 1
   ```

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

Smart account, verifier and spending-limit code come from
[OpenZeppelin Stellar Contracts](https://github.com/OpenZeppelin/stellar-contracts) (MIT).
Payments use [x402](https://developers.stellar.org/docs/build/agentic-payments/x402).
