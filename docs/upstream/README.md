# Upstream contribution: smart-account payments in x402 Stellar facilitators

**Status: nothing has been filed yet.** No issue, comment, pull request, fork or push exists. Everything in this folder is local.

Files:

- `x402-stellar-smart-account-events.patch`: the change for `x402-foundation/x402`.
- `README.md`: this file, with the texts to post.

## Read this first: the problem is already reported upstream

Checked on 2026-11-18. Opening new issues would duplicate these, so the texts below are written to be posted as comments on the existing threads.

| Where | What | State |
| --- | --- | --- |
| x402 issue #3352 | Event check rejects smart-account payers | Open, no maintainer reply |
| x402 issue #3764 | Same, with the OpenZeppelin spending-limit policy | Open, no replies |
| x402 PR #3399 | Only checks events emitted by the payment asset, ignores all others | Open since Sep 8, no maintainer review, now conflicts with `main` |
| x402 issue #3515 | 50,000 stroop fee ceiling rejects smart-account payers | Open |
| x402 PR #4065 | Publishes the fee ceiling in `/supported` | Open, waiting for a maintainer |
| OpenZeppelin plugin issue #53 | Same event check in the hosted facilitator | Open, no replies |

Latest `main` of x402 (commit below) does not handle policy events and has no event filter option.

## The problem

Mandate pays x402 sellers from a Stellar smart account (C-address, OpenZeppelin `stellar-accounts` 0.8.0). Each payment runs a signature verifier contract and policy contracts in `__check_auth`. The stock facilitator scheme (`ExactStellarScheme` in `@x402/stellar` 2.31.0) rejects these payments for two reasons:

1. **Fee ceiling.** `maxTransactionFeeStroops` defaults to 50,000 stroops (0.005 XLM). A smart-account payment costs roughly 500,000 stroops (0.05 XLM) because the verifier and policies run on chain. Verify returns `invalid_exact_stellar_payload_fee_exceeds_maximum`.
2. **Event check.** `validateSimulationEvents` requires exactly one contract event, the SEP-41 `transfer`. Our contracts emit more: the spending-limit policy update, `PaymentAuthorized` from the verified-seller policy and `AgentAuthorized` from the agent verifier. Verify returns `invalid_exact_stellar_payload_event_not_transfer`.

Our current workaround is the private subclass in `apps/facilitator/src/index.ts`. It raises the ceiling and overrides the private `validateSimulationEvents` to drop events from three known contract IDs.

## What the patch changes

Base: `x402-foundation/x402` commit `911709c32e62641f7bd4df345b2029ebe84968c8` (`main` on 2026-11-17). 4 files, +152 and -6 lines.

- `typescript/packages/mechanisms/stellar/src/exact/facilitator/scheme.ts`: new optional constructor option `allowedAuthEventContracts?: string[]` (default empty). Events emitted by a listed contract are skipped by the event check. Events from the payment asset are never skipped, even if the asset is listed. Entries must be contract addresses or the constructor throws. With the option unset, behaviour and error codes are identical to today.
- `typescript/packages/mechanisms/stellar/test/unit/facilitator-verify.test.ts`: 5 tests in the existing style (allowed emitter accepted and rejected by default, unlisted emitter rejected, transfer still required, asset never skipped, bad address rejected).
- `typescript/packages/mechanisms/stellar/README.md`: a "Smart-Account Payers" section covering both the fee ceiling and the new option.
- `typescript/.changeset/stellar-allowed-auth-event-contracts.md`: changeset (minor), as the repository requires.

Fees need no code change: `maxTransactionFeeStroops` is already a constructor option. The patch only documents it.

## Why this shape

Two designs were considered.

- **Opt-in allowlist (chosen).** The operator names the contracts whose events are ignored. Default behaviour does not change, the diff is small, and it does not depend on how the spec rule "no other balance changes" is read.
- **General rule (PR #3399).** Only interpret events from the payment asset and ignore events from every other contract, or ignore everything that is not a SEP-41 token event. No configuration is needed, so it is the only design that lets a public facilitator accept any smart account. It changes default behaviour, and event names are chosen by each contract, so a facilitator cannot tell another token's balance change from an informational event. The PR author flags this as needing a maintainer decision, and it has had no review in ten weeks.

So the allowlist is offered as the fallback that can merge now, not as a replacement for #3399. One honest limit: with the allowlist, a hosted facilitator accepts Mandate payments only if its operator lists our three contract IDs. If #3399 lands, the allowlist is not needed.

## How to apply

```sh
git clone https://github.com/x402-foundation/x402
cd x402
git checkout 911709c32e62641f7bd4df345b2029ebe84968c8
git apply /path/to/mandate/docs/upstream/x402-stellar-smart-account-events.patch
```

The patch targets `main`, which has moved to `@stellar/stellar-sdk` 17. It does not apply to the published 2.31.0 sources, which use SDK 16.

## Tests

The upstream unit tests were **not run**. The clone was treated as untrusted, so nothing was installed or executed in it. What was checked instead:

- The patch applies cleanly to a pristine export of the base commit.
- `scheme.ts` and the edited test file type-check with TypeScript 5.9.3 against `@stellar/stellar-sdk` 17.4.0 and `@x402/core` 2.31.0 (vitest types stubbed).
- The SDK calls used by the new fixtures were exercised in a separate script.

To run the real suite after applying:

```sh
cd typescript
pnpm install
pnpm --filter @x402/stellar test
pnpm --filter @x402/stellar lint:check
pnpm --filter @x402/stellar format:check
```

## Before posting

- Run the tests above and fix anything they find. Formatting was matched by hand, not with prettier.
- The texts say the tests have not been run. Update that sentence once they pass.
- Add a testnet transaction hash of a settled Mandate payment if you have one. It makes the report much stronger.
- x402 requires signed commits and asks contributors to disclose AI assistance. The disclosure line is already in the texts.

## Text for x402-foundation/x402

Recommended: post the body as a comment on issue #3352. Use the title only if you open a pull request with the patch.

**Title**

```
feat(stellar): opt-in allowedAuthEventContracts for smart-account payers
```

**Body**

```
Related: #3352, #3764 (same event check), #3399 (open PR that scopes the check to the asset contract), #3515 and #4065 (fee ceiling).

**What we see**

We pay x402 sellers from a Stellar smart account (C-address, OpenZeppelin `stellar-accounts` 0.8.0). Each payment runs a signature verifier contract and policy contracts in `__check_auth`. With `@x402/stellar` 2.31.0 on testnet, the stock facilitator scheme rejects the payment for two reasons:

1. `invalid_exact_stellar_payload_fee_exceeds_maximum`. The payment costs roughly 500,000 stroops (0.05 XLM) because the verifier and policies run on chain. The default `maxTransactionFeeStroops` is 50,000.
2. `invalid_exact_stellar_payload_event_not_transfer`. The simulation emits the token `transfer` plus events from our contracts: the spending-limit policy, `PaymentAuthorized` from a verified-seller policy and `AgentAuthorized` from an agent verifier. `validateSimulationEvents` rejects any contract event that is not the transfer.

Our own facilitator raises the ceiling and drops events from those three emitters before running the stock check, and the same payments then settle. It does this by overriding the private `validateSimulationEvents` in a subclass, which we would like to stop doing.

**Proposal**

#3399 is the general fix and we would be glad to see it merged. It changes default behaviour and depends on how the spec rule "no other balance changes" is read. Here is a smaller option that does not need that decision:

- A new optional constructor option on the facilitator `ExactStellarScheme`: `allowedAuthEventContracts?: string[]`. It is empty by default, so verification is unchanged unless an operator sets it.
- Events emitted by a listed contract are skipped by the event check. Events from `requirements.asset` are never skipped, even if the asset is listed.
- Everything else stays: exactly one `transfer` from the asset with the expected sender, recipient and amount, and any event from an unlisted contract is rejected as before.
- Entries are validated as contract addresses in the constructor.
- A README section for smart-account payers that also documents the fee ceiling.

Limit of this option: the operator has to list contracts. It suits self-hosted facilitators and hosted ones that list well-known policy deployments. It does not make a public facilitator accept arbitrary smart accounts. #3399 does.

I have a patch against `911709c` (scheme.ts, 5 unit tests in facilitator-verify.test.ts, README, changeset, +152/-6) and can open a pull request if this direction is useful. It type-checks against `@stellar/stellar-sdk` 17.4.0. I have not run the unit test suite yet.

AI assistance: the patch and the first draft of this text were written with Claude Code.
```

## Findings: OpenZeppelin/relayer-plugin-x402-facilitator

Read at commit `310480be041c3b89b336c7d07d4c8c2e76934a05` (version 0.6.0). No patch was written for it.

- **It does not use `@x402/stellar`.** Verification is its own code in `src/stellar/verify.ts` and `src/stellar/utils.ts`. Only the examples depend on `@x402/*` packages. A fix in `@x402/stellar` will not change `channels.openzeppelin.com/x402`.
- **Event check.** `parseTransferEventsFromSimulation` in `src/stellar/utils.ts` flags every contract event that is not a `transfer`, and `validateSimulationEvents` in the same file then fails with `invalid_exact_stellar_payload_event_not_transfer`. No configuration relaxes this, so accepting our payments needs a code change there.
- **Fee ceiling.** `maxTransactionFeeStroops` is an optional per-network setting (`NetworkConfig` in `src/types.ts`, enforced in step 10 of `src/stellar/verify.ts`, documented under "Fee ceiling" in its `README.md`). There is no default in code: if unset, no ceiling applies. The value used by the hosted facilitator is deployment configuration and is not in the repository. Settlement through the Channels service can also hit a per-API-key fee limit.
- **What the hosted facilitator would need.** (1) An event allowlist or the asset-scoped check, in code. (2) A fee ceiling, and Channels fee limit, above roughly 500,000 stroops per payment.
- The other checks (address credentials only, no sub-invocations, signed payer entry) appear to accept a smart-account payer. The reporter of issue #53 reached the event check with one on the hosted testnet facilitator.

## Text for OpenZeppelin/relayer-plugin-x402-facilitator

Recommended: post the body as a comment on issue #53.

**Title**

```
Stellar verify: allow events from smart-account policy contracts, and state the hosted fee ceiling
```

**Body**

```
We pay x402 sellers from a Stellar smart account built on OpenZeppelin `stellar-accounts` 0.8.0. Each payment runs a signature verifier contract and policy contracts in `__check_auth`, and those contracts emit their own events. Reading the plugin at `310480b` (0.6.0), two things stop such a payment:

1. Event check. `parseTransferEventsFromSimulation` in `src/stellar/utils.ts` sets `nonTransferContractEventDetected` for any contract event that is not a `transfer`, and `validateSimulationEvents` then fails with `invalid_exact_stellar_payload_event_not_transfer`. No configuration relaxes this.
2. Fee ceiling. `maxTransactionFeeStroops` is optional per network and has no default in code, so the limit on channels.openzeppelin.com/x402 is deployment configuration we cannot see. Our payments cost roughly 500,000 stroops (0.05 XLM) because the verifier and policies run on chain. A ceiling near the 50,000 default of `@x402/stellar`, or a Channels per-key fee limit below our cost, rejects them.

Requests:

- A per-network option, for example `allowedAuthEventContracts: string[]`, whose emitters are skipped in `parseTransferEventsFromSimulation`. The asset's own events stay fully checked and exactly one matching transfer is still required. I have prepared the same opt-in change for `@x402/stellar` (see x402-foundation/x402#3352 and x402-foundation/x402#3399) and can send a matching pull request here. The asset-scoped check suggested in #53 would also solve it without configuration.
- For the hosted facilitator: document which fee ceiling applies, and consider a value that admits smart-account payers. Reports in x402-foundation/x402#3515 and ours put these payments at about 300,000 to 500,000 stroops.

AI assistance: the first draft of this text was written with Claude Code.
```
