# Mandate x402 facilitator

An [x402](https://www.x402.org) facilitator for Stellar that settles payments made from smart accounts with policies. It is the stock `ExactStellarScheme` from [`@x402/stellar`](https://github.com/x402-foundation/x402) (Apache-2.0) with two changes, about 30 lines in [src/index.ts](src/index.ts).

Open on Stellar testnet at **https://mandate.fly.dev:4023**. It is rate limited and may be reset at any time.

## Why it exists

A payment from an [OpenZeppelin smart account](https://github.com/OpenZeppelin/stellar-contracts) runs its verifier and policies inside `__check_auth`. Stock facilitators reject that payment for two reasons, both found by testing on testnet:

| Check | Stock behaviour | A Mandate payment | This facilitator |
|---|---|---|---|
| Fee ceiling | `maxTransactionFeeStroops` defaults to 50,000 (0.005 XLM) | About 500,000 stroops (0.05 XLM), because a verifier and two policies run on chain | Ceiling of 3,000,000, set with `FACILITATOR_MAX_FEE_STROOPS` |
| Event check | The simulation must emit exactly one contract event, the token transfer | Also emits the spending-limit update, `PaymentAuthorized` and `AgentAuthorized` | Events from an allow-list of contracts are ignored; the one expected transfer is still required |

Everything else is unchanged: the payer's signature, the asset, the amount, the recipient and the single transfer are verified as upstream does.

## Upstream

We would rather this were not a fork. [docs/upstream](../../docs/upstream) has the same change as a patch for `@x402/stellar`, and notes on what the OpenZeppelin-hosted facilitator would need.

## Run it

```bash
pnpm setup:stores
```

```bash
pnpm dev:facilitator
```

`setup:stores` creates and funds the fee-paying key (`FACILITATOR_SECRET`) on testnet. Then point an x402 seller at `http://localhost:4023`.

| Setting | Default | Meaning |
|---|---|---|
| `FACILITATOR_SECRET` | none | Classic account that submits settlements and pays their fees |
| `FACILITATOR_PORT` | `4023` | Port |
| `FACILITATOR_HOST` | `127.0.0.1` | Set to `0.0.0.0` to accept other machines |
| `FACILITATOR_MAX_FEE_STROOPS` | `3000000` | Most it will pay for one settlement |
| `FACILITATOR_ALLOWED_EVENT_CONTRACTS` | Mandate's spending-limit policy, verified-seller policy and agent verifier | Comma-separated contract IDs whose events the single-transfer check ignores. Set this to use it with another smart account's policies |
| `FACILITATOR_REQUESTS_PER_MINUTE` | `30` | Per caller, for `/verify` and `/settle` |
| `FACILITATOR_SETTLES_PER_HOUR` | `300` | Across all callers |

## Endpoints

- `GET /` describes this instance: network, fee ceiling, allowed contracts and limits.
- `GET /supported`, `POST /verify`, `POST /settle` follow the x402 facilitator API.
