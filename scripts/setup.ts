// One-time testnet setup for the combined Mandate demo. Safe to run again.
//
//   1. Generates the vault encryption key.
//   2. Uploads the smart-account contract code (accounts are deployed per customer).
//   3. Reads the registry admin key from the Stellar CLI identity.
//   4. Creates the demo-dollar token (a Stellar asset issued from the vault).
//   5. Gives each demo store a funded account and a trustline for demo dollars.
//   6. Registers FreshMart and GreenLeaf as trusted stores. FreshMarrt stays untrusted.
//
// Needs the contracts from scripts/deploy-contracts.sh (ids in .env) and the
// Stellar CLI with the `mandate-deployer` identity.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { Asset, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { StellarGateway, stellarConfig } from "../apps/receipts/src/payments/stellar.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const envPath = `${root}.env`;
const values: Record<string, string> = existsSync(envPath) ? (parseEnv(readFileSync(envPath, "utf8")) as Record<string, string>) : {};
const changed = new Set<string>();
const set = (name: string, value: string) => { if (values[name] !== value) { values[name] = value; changed.add(name); } };

/** Writes changed keys back in place, keeping every other line of .env. */
function save() {
  let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  for (const name of changed) {
    const line = `${name}=${values[name]}`;
    const pattern = new RegExp(`^${name}=.*$`, "m");
    text = pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\n?$/, "\n")}${line}\n`;
  }
  writeFileSync(envPath, text, { mode: 0o600 });
}

const identity = values.STELLAR_SOURCE || "mandate-deployer";
const stellar = (args: string[]) => execFileSync("stellar", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const horizonUrl = values.PAYMENTS_HORIZON_URL || "https://horizon-testnet.stellar.org";
const horizon = new Horizon.Server(horizonUrl);

for (const name of ["ED25519_VERIFIER_ID", "SPENDING_LIMIT_POLICY_ID", "SELLER_REGISTRY_ID", "VERIFIED_SELLER_POLICY_ID", "MERCHANT_SECRET", "IMPOSTOR_SECRET", "FACILITATOR_SECRET"]) {
  if (!values[name]) throw new Error(`${name} is missing from .env. Run pnpm setup:testnet and scripts/deploy-contracts.sh first.`);
}

if (!values.PAYMENTS_ENCRYPTION_KEY) set("PAYMENTS_ENCRYPTION_KEY", randomBytes(32).toString("hex"));

if (!values.SMART_ACCOUNT_WASM_HASH) {
  const wasm = "contracts/target/wasm32v1-none/release/mandate_account.wasm";
  if (!existsSync(`${root}${wasm}`)) throw new Error(`Build the contracts first: ${wasm} is missing`);
  set("SMART_ACCOUNT_WASM_HASH", stellar(["contract", "upload", "--network", "testnet", "--source", identity, "--wasm", wasm]));
  console.log("Uploaded the smart-account contract code");
}

if (!values.PAYMENTS_REGISTRY_ADMIN_SECRET) {
  const secret = stellar(["keys", "secret", identity]);
  if (!/^S[A-Z2-7]{55}$/.test(secret)) throw new Error(`The ${identity} identity did not give a secret key`);
  set("PAYMENTS_REGISTRY_ADMIN_SECRET", secret);
}

if (!values.GREENLEAF_SECRET) {
  const key = Keypair.random();
  set("GREENLEAF_SECRET", key.secret());
  set("GREENLEAF_ADDRESS", key.publicKey());
}
save();

async function funded(key: Keypair) {
  try { await horizon.loadAccount(key.publicKey()); return; } catch { /* not yet */ }
  const response = await fetch(`https://friendbot.stellar.org?addr=${key.publicKey()}`);
  if (!response.ok) throw new Error(`Friendbot could not fund ${key.publicKey()}`);
}

async function trustline(key: Keypair, asset: Asset) {
  const account = await horizon.loadAccount(key.publicKey());
  if (account.balances.some((b) => "asset_code" in b && b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer())) return;
  const tx = new TransactionBuilder(account, { fee: "10000", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(60)
    .build();
  tx.sign(key);
  await horizon.submitTransaction(tx);
}

const dbPath = values.PAYMENTS_CHAIN_DB || `${root}apps/receipts/workspace.sqlite`;
const gateway = new StellarGateway(dbPath, stellarConfig({ ...process.env, ...values }));
try {
  await gateway.check();
  const usd = await gateway.ensureUsd();
  set("MERCHANT_ASSET", usd.tokenContract);
  set("AGENT_EXTRA_ASSET", usd.tokenContract);
  save();
  console.log(`Demo dollars: token ${usd.tokenContract}`);
  const asset = new Asset("USD", usd.issuer);

  const stores = [
    { name: "FreshMart", secret: values.MERCHANT_SECRET!, domain: "freshmart.example", trusted: true },
    { name: "GreenLeaf Market", secret: values.GREENLEAF_SECRET!, domain: "greenleaf.example", trusted: true },
    { name: "FreshMarrt (look-alike)", secret: values.IMPOSTOR_SECRET!, domain: "freshmarrt.example", trusted: false },
  ];
  for (const store of stores) {
    const key = Keypair.fromSecret(store.secret);
    await funded(key);
    await trustline(key, asset);
    if (store.trusted && !(await gateway.isTrusted(key.publicKey()))) await gateway.registerStore(key.publicKey(), store.domain);
    const trusted = await gateway.isTrusted(key.publicKey());
    console.log(`${store.name}: ${trusted ? "trusted" : "not trusted"} (${key.publicKey()})`);
    if (trusted !== store.trusted) console.warn(`  expected ${store.trusted ? "trusted" : "not trusted"}`);
  }
} finally {
  gateway.close();
}
console.log(changed.size ? `Updated .env: ${[...changed].join(", ")}` : ".env already up to date");
console.log("Start the services: pnpm dev");
