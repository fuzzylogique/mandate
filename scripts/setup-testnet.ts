// Creates funded testnet accounts (merchant, agent, owner, facilitator), gives each
// a USDC trustline, and writes them to .env. Safe to re-run: accounts already
// present in .env are kept.
//
// Afterwards, get testnet USDC from https://faucet.circle.com (pick Stellar
// testnet). The faucet has a captcha, so this step is manual.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

const ENV_PATH = new URL("../.env", import.meta.url);
const EXAMPLE_PATH = new URL("../.env.example", import.meta.url);
const HORIZON_URL = "https://horizon-testnet.stellar.org";
// Circle's testnet USDC issuer (classic asset; the SAC address is derived from it).
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const ROLES = ["MERCHANT", "AGENT", "OWNER", "FACILITATOR"] as const;

const horizon = new Horizon.Server(HORIZON_URL);

function readEnv(): Map<string, string> {
  const source = existsSync(ENV_PATH) ? ENV_PATH : EXAMPLE_PATH;
  const values = new Map<string, string>();
  for (const line of readFileSync(source, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) values.set(match[1]!, match[2]!);
  }
  return values;
}

function writeEnv(values: Map<string, string>): void {
  // Keep the example file's comments and ordering; only fill in the values.
  const template = readFileSync(EXAMPLE_PATH, "utf8");
  const output = template
    .split("\n")
    .map((line) => {
      const match = /^([A-Z0-9_]+)=/.exec(line);
      return match && values.has(match[1]!) ? `${match[1]}=${values.get(match[1]!)}` : line;
    })
    .join("\n");
  writeFileSync(ENV_PATH, output, { mode: 0o600 });
}

async function fund(publicKey: string): Promise<void> {
  const response = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
  // Friendbot answers 400 when the account is already funded.
  if (!response.ok && response.status !== 400) {
    throw new Error(`Friendbot failed for ${publicKey}: ${response.status}`);
  }
}

async function addUsdcTrustline(keypair: Keypair): Promise<void> {
  const account = await horizon.loadAccount(keypair.publicKey());
  const hasTrustline = account.balances.some(
    (balance) =>
      "asset_code" in balance &&
      balance.asset_code === USDC.code &&
      balance.asset_issuer === USDC.issuer,
  );
  if (hasTrustline) return;

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(60)
    .build();
  tx.sign(keypair);
  await horizon.submitTransaction(tx);
}

const env = readEnv();

for (const role of ROLES) {
  const existing = env.get(`${role}_SECRET`);
  const keypair = existing ? Keypair.fromSecret(existing) : Keypair.random();
  env.set(`${role}_ADDRESS`, keypair.publicKey());
  env.set(`${role}_SECRET`, keypair.secret());

  await fund(keypair.publicKey());
  await addUsdcTrustline(keypair);
  console.log(`${role.toLowerCase().padEnd(11)} ${keypair.publicKey()}  funded, USDC trustline ready`);
}

writeEnv(env);
console.log("\nWrote .env (secrets are in the file, not printed here).");
console.log("Next: send testnet USDC to the AGENT address from https://faucet.circle.com");
