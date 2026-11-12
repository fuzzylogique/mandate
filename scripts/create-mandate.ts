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
import { Address, Keypair, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { externalSigner } from "../packages/shared/src/smart-account.ts";
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

const symbol = (name: string) => xdr.ScVal.scvSymbol(name);
const address = (id: string) => Address.fromString(id).toScVal();
const struct = (fields: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((key) => new xdr.ScMapEntry({ key: symbol(key), val: fields[key]! })),
  );

// Tokens use 7 decimals: "1" -> 10_000_000 base units.
const [whole = "0", fraction = ""] = values.limit.split(".");
const limitBaseUnits = BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0").slice(0, 7));

// Policy address -> install parameters. Map keys must be sorted by address.
const policies = [
  {
    id: env("SPENDING_LIMIT_POLICY_ID"),
    params: struct({
      spending_limit: nativeToScVal(limitBaseUnits, { type: "i128" }),
      period_ledgers: xdr.ScVal.scvU32(Number(values["period-ledgers"])),
    }),
  },
  {
    id: env("VERIFIED_SELLER_POLICY_ID"),
    params: struct({ registry: address(env("SELLER_REGISTRY_ID")) }),
  },
].sort((a, b) =>
  Buffer.compare(Address.fromString(a.id).toBuffer(), Address.fromString(b.id).toBuffer()),
);

const { txHash, result } = await invokeAsSmartAccount({
  contractId: smartAccount,
  method: "add_context_rule",
  args: [
    xdr.ScVal.scvVec([symbol("CallContract"), address(values.token)]),
    nativeToScVal(values.name, { type: "string" }),
    values["valid-until"] ? xdr.ScVal.scvU32(Number(values["valid-until"])) : xdr.ScVal.scvVoid(),
    xdr.ScVal.scvVec([externalSigner(verifier, agent)]),
    xdr.ScVal.scvMap(
      policies.map((policy) => new xdr.ScMapEntry({ key: address(policy.id), val: policy.params })),
    ),
  ],
  feePayer: owner,
  signer: { smartAccount, verifier, keypair: owner },
  contextRuleId: OWNER_RULE_ID,
});

const rule = scValToNative(result) as { id: number; name: string };
console.log(`Mandate "${rule.name}" created: context rule ${rule.id}`);
console.log(`  token ${values.token}, limit ${values.limit} per ${values["period-ledgers"]} ledgers`);
console.log(`  tx ${txHash}`);
console.log(`Set AGENT_CONTEXT_RULE_ID=${rule.id} in .env`);
