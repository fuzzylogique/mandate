# Project Showcase form: draft answers

Form: https://airtable.com/apprwC5wqwb4We3jo/pageD4iVuMUuoOvFs/form
Due Friday Nov 13, 8:30 AM. Items marked **[fill in]** need the team.

## Team topic and number

**[fill in]** Topic is Problem Space 2, Verification Infrastructure for the Next Billion Customers.

## Team name

**[fill in]** "Mandate" is a working name for the project, not necessarily the team.

## Team members

**[fill in]**

## One-line summary

Mandate lets a person or small business give an AI agent a spending limit and a
list of verified sellers, enforced on Stellar, with a receipt for every purchase.

## What specific problem is your solution working to solve, how does it benefit the future of this problem space?

AI agents are starting to pay for things on their owners' behalf, but today
giving an agent money means giving it a key with no limits. The owner cannot cap
what it spends, cannot restrict who it pays, and gets no record tying a payment
to the agent that made it and the person who authorized it. Most agent-payment
work so far helps sellers accept payments; the buyer side is largely unbuilt.
This is the gap Problem Space 2 names: the identity and authorization of
software agents acting for people must be provable.

Mandate is a Stellar smart account where the owner issues each agent a mandate:
a spending limit per period, verified sellers only, and an expiry date. Soroban
contracts check these rules at payment time, so an over-limit payment or a
payment to an impersonator fails on-chain, whatever the agent does. Every
payment that succeeds produces a receipt showing the agent, the authorizing
owner, the verified seller, the amount and the transaction.

For the problem space, this gives wallets, payment providers and small
businesses a way to let agents transact without giving up control. It also
creates a reusable on-chain proof that "this agent was authorized by this
person to do this", which any institution can check without verifying the
agent again. It runs on USDC with sponsored fees, so an owner needs no card, no
credit check and no knowledge of crypto.

## Why is your team best suited to solve this problem?

**[fill in: the paragraph below is a skeleton; replace the bracketed parts with true details]**

We are [N] University of Waterloo students in [programs], with experience in
[e.g. backend, smart contracts, payments, AI agents: name real projects or
co-ops]. We tested the idea with a Stellar product manager, who confirmed that
buyer-side tooling for agent payments is the neglected half of the market, and
with a technical advisor, who pointed us to Stellar smart accounts and policy
signers as the right foundation. [If true: we use AI agents ourselves and have
hit this problem directly: describe it in one sentence.] We already have a
working prototype on Stellar testnet: an agent pays an x402 seller from a smart
account under a mandate, payments over the limit or to an unverified seller are
rejected on-chain, and each successful payment produces a receipt.

## Devpost link

**[fill in]** Create the project at https://blockchain-stellar-ic.devpost.com/ and paste its link. It does not need to be complete by Friday.
