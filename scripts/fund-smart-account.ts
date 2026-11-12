// Moves tokens from the owner's classic account into the smart account.
// The Circle faucet pays out to classic (G) accounts, so USDC arrives at the
// owner first and is moved here.
//
// Usage: node --env-file=.env scripts/fund-smart-account.ts --amount <units> [--token <C...>]
import { parseArgs } from "node:util";
import { Address, contract, Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import { env, NETWORK_PASSPHRASE, RPC_URL } from "./lib.ts";

const TESTNET_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

const { values } = parseArgs({
  options: {
    amount: { type: "string" },
    token: { type: "string", default: TESTNET_USDC },
  },
});
if (!values.amount) {
  console.error("Usage: fund-smart-account.ts --amount <units> [--token <C...>]");
  process.exit(1);
}

const owner = Keypair.fromSecret(env("OWNER_SECRET"));
const smartAccount = env("SMART_ACCOUNT_ID");
const [whole = "0", fraction = ""] = values.amount.split(".");
const baseUnits = BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0").slice(0, 7));

const tx = await contract.AssembledTransaction.build({
  contractId: values.token,
  method: "transfer",
  args: [
    Address.fromString(owner.publicKey()).toScVal(),
    Address.fromString(smartAccount).toScVal(),
    nativeToScVal(baseUnits, { type: "i128" }),
  ],
  networkPassphrase: NETWORK_PASSPHRASE,
  rpcUrl: RPC_URL,
  publicKey: owner.publicKey(),
  parseResultXdr: () => undefined,
});
const { signTransaction } = contract.basicNodeSigner(owner, NETWORK_PASSPHRASE);
const sent = await tx.signAndSend({ signTransaction });
console.log(
  `Moved ${values.amount} from owner to smart account ${smartAccount} (tx ${sent.sendTransactionResponse?.hash})`,
);
