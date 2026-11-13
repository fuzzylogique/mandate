// Creates a mandate: a context rule on the owner's smart account that lets
// one agent key spend one token, within a limit, to verified sellers only.
// The owner signs it; the agent cannot create or change its own mandate.
//
// Usage:
//   node --env-file=.env scripts/create-mandate.ts [--token <C...>] [--limit <units>]
//        [--period-ledgers <n>] [--name <label>] [--valid-until <ledger>]
//
// Defaults: testnet USDC, limit 1 (one whole token), period 17280 ledgers (~1 day).
import { parseArgs } from "node:util";
import { Keypair, scValToNative } from "@stellar/stellar-sdk";
import { toBaseUnits } from "../packages/shared/src/index.ts";
import { mandateArgs } from "../packages/shared/src/smart-account.ts";
import { env, invokeAsSmartAccount } from "./lib.ts";

const TESTNET_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const OWNER_RULE_ID = 0;

const { values } = parseArgs({
  options: {
    token: { type: "string", default: TESTNET_USDC },
    limit: { type: "string", default: "1" },
    "period-ledgers": { type: "string", default: "17280" },
    name: { type: "string", default: "agent" },
    "valid-until": { type: "string" },
  },
});

const smartAccount = env("SMART_ACCOUNT_ID");
const verifier = env("ED25519_VERIFIER_ID");
const owner = Keypair.fromSecret(env("OWNER_SECRET"));
const agent = Keypair.fromPublicKey(env("AGENT_ADDRESS"));

// Tokens use 7 decimals: "1" -> 10_000_000 base units.
const { txHash, result } = await invokeAsSmartAccount({
  contractId: smartAccount,
  method: "add_context_rule",
  args: mandateArgs({
    token: values.token,
    name: values.name,
    limitBaseUnits: BigInt(toBaseUnits(values.limit)),
    periodLedgers: Number(values["period-ledgers"]),
    validUntilLedger: values["valid-until"] ? Number(values["valid-until"]) : undefined,
    agent,
    verifier,
    spendingLimitPolicy: env("SPENDING_LIMIT_POLICY_ID"),
    verifiedSellerPolicy: env("VERIFIED_SELLER_POLICY_ID"),
    sellerRegistry: env("SELLER_REGISTRY_ID"),
  }),
  feePayer: owner,
  signer: { smartAccount, verifier, keypair: owner },
  contextRuleId: OWNER_RULE_ID,
});

const rule = scValToNative(result) as { id: number; name: string };
console.log(`Mandate "${rule.name}" created: context rule ${rule.id}`);
console.log(`  token ${values.token}, limit ${values.limit} per ${values["period-ledgers"]} ledgers`);
console.log(`  tx ${txHash}`);
console.log(`Set AGENT_CONTEXT_RULE_ID=${rule.id} in .env`);
