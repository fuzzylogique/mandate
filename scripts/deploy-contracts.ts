import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Networks } from "@stellar/stellar-sdk";
import { StellarGateway, stellarConfig } from "../apps/receipts/src/payments/stellar.ts";
import { readConfiguration, writeConfiguration } from "./config.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const values = readConfiguration();
const identity = process.env.STELLAR_SOURCE || values.STELLAR_SOURCE || "mandate-deployer";
if (!/^[A-Za-z0-9_-]+$/.test(identity)) throw new Error("Invalid Stellar CLI identity name");
const run = (args: string[]) => execFileSync("stellar", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const network = ["--rpc-url", values.PAYMENTS_RPC_URL!, "--network-passphrase", Networks.TESTNET];
let admin: string;
try { admin = run(["keys", "address", identity]); }
catch { run(["keys", "generate", identity]); admin = run(["keys", "address", identity]); }
try { run(["keys", "fund", identity, "--network", "testnet"]); }
catch {
  const response = await fetch(`${values.PAYMENTS_HORIZON_URL}/accounts/${admin}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error("Could not fund the deployment identity on Stellar testnet");
}
execFileSync("stellar", ["contract", "build", "--manifest-path", "contracts/Cargo.toml"], { cwd: root, stdio: "inherit" });
const wasm = (name: string) => `contracts/target/wasm32v1-none/release/${name}.wasm`;
if (!values.SMART_ACCOUNT_WASM_HASH) {
  values.SMART_ACCOUNT_WASM_HASH = run(["contract", "upload", ...network, "--source", identity, "--wasm", wasm("mandate_account")]);
  console.log(`Uploaded account WASM: ${values.SMART_ACCOUNT_WASM_HASH}`);
}
for (const [setting, name, args] of [
  ["ED25519_VERIFIER_ID", "mandate_ed25519_verifier", []],
  ["SPENDING_LIMIT_POLICY_ID", "mandate_spending_limit_policy", []],
  ["AGENT_REGISTRY_ID", "mandate_agent_registry", ["--admin", admin]],
  ["SELLER_REGISTRY_ID", "mandate_seller_registry", ["--admin", admin]],
  ["PAYMENTS_VERIFIED_SMART_POLICY_ID", "mandate_verified_smart_policy", []],
] as const) {
  if (values[setting]) continue;
  values[setting] = run(["contract", "deploy", ...network, "--source", identity, "--wasm", wasm(name), ...(args.length ? ["--", ...args] : [])]);
  console.log(`${setting}: ${values[setting]}`);
}
if (!values.AGENT_VERIFIER_ID) {
  values.AGENT_VERIFIER_ID = run(["contract", "deploy", ...network, "--source", identity, "--wasm", wasm("mandate_agent_verifier"), "--", "--registry", values.AGENT_REGISTRY_ID!]);
  console.log(`AGENT_VERIFIER_ID: ${values.AGENT_VERIFIER_ID}`);
}
if (!values.PAYMENTS_REGISTRY_ADMIN_SECRET) {
  try { values.PAYMENTS_REGISTRY_ADMIN_SECRET = run(["keys", "secret", identity]); }
  catch { throw new Error("Could not read the deployment identity key"); }
  if (!/^S[A-Z2-7]{55}$/.test(values.PAYMENTS_REGISTRY_ADMIN_SECRET)) throw new Error("The deployment identity must provide a Stellar secret key");
}
values.STELLAR_SOURCE = identity;
const gateway = new StellarGateway(":memory:", stellarConfig(values));
try { await gateway.check(); } finally { gateway.close(); }
writeConfiguration(values);
console.log("Current contracts and registry administrator configured in .env. No secrets were printed. Run pnpm dev.");
