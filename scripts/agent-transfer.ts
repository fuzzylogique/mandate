// Sends a token transfer from the smart account, signed by the agent under
// its mandate. No x402 involved: this exercises the mandate rules directly.
//
// Usage:
//   node --env-file=.env scripts/agent-transfer.ts --to <G... or C...> --amount <units>
//        [--token <C...>] [--rule <id>]
import { parseArgs } from "node:util";
import { Address, Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import { env, invokeAsSmartAccount } from "./lib.ts";

const TESTNET_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

const { values } = parseArgs({
  options: {
    to: { type: "string" },
    amount: { type: "string" },
    token: { type: "string", default: TESTNET_USDC },
    rule: { type: "string" },
  },
});
if (!values.to || !values.amount) {
  console.error("Usage: agent-transfer.ts --to <address> --amount <units> [--token <C...>] [--rule <id>]");
  process.exit(1);
}

const smartAccount = env("SMART_ACCOUNT_ID");
const agent = Keypair.fromSecret(env("AGENT_SECRET"));
const ruleId = Number(values.rule ?? env("AGENT_CONTEXT_RULE_ID"));

const [whole = "0", fraction = ""] = values.amount.split(".");
const baseUnits = BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0").slice(0, 7));

try {
  const { txHash } = await invokeAsSmartAccount({
    contractId: values.token,
    method: "transfer",
    args: [
      Address.fromString(smartAccount).toScVal(),
      Address.fromString(values.to).toScVal(),
      nativeToScVal(baseUnits, { type: "i128" }),
    ],
    // The agent's own classic account pays the network fee.
    feePayer: agent,
    signer: { smartAccount, verifier: env("ED25519_VERIFIER_ID"), keypair: agent },
    contextRuleId: ruleId,
  });
  console.log(`PAID ${values.amount} to ${values.to} under rule ${ruleId} (tx ${txHash})`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // Contract errors surface as "Error(Contract, #N)" inside the simulation log.
  const code = /Error\(Contract, #(\d+)\)/.exec(message)?.[1];
  console.log(`BLOCKED ${values.amount} to ${values.to} under rule ${ruleId}` + (code ? ` (contract error #${code})` : ""));
  if (!code) console.log(message.slice(0, 600));
  process.exitCode = 2;
}
