// Sets up the x402 demo: three vendors that are real Mandate accounts (so
// their smart accounts are verified sellers, listed in the vendor directory),
// one look-alike that is not, and a facilitator key that submits x402 payments
// and pays their fees.
//
// Run with the API up (pnpm dev). Vendor logins are test values for this demo
// only; they are kept in .env and never printed.
//
// To set up another deployment, point PAYMENTS_API_URL at it and name a
// separate settings file, so local values are left alone:
//
//   PAYMENTS_API_URL=https://mandate.fly.dev STORES_SETTINGS_FILE=.env.fly pnpm setup:stores
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { addressSetting, passwordSetting, vendors, type VendorConfig } from "../apps/merchant/src/vendors.ts";
import { readConfiguration, writeConfiguration } from "./config.ts";

const local = readConfiguration();
const api = process.env.PAYMENTS_API_URL || local.PAYMENTS_API_URL || "http://localhost:4022";
// Another deployment's vendor settings live in their own file, which only holds what this script writes.
const settingsFile = process.env.STORES_SETTINGS_FILE;
const values: Record<string, string> = settingsFile ? (existsSync(settingsFile) ? Object.fromEntries(Object.entries(parseEnv(readFileSync(settingsFile, "utf8"))).filter((entry): entry is [string, string] => entry[1] !== undefined)) : {}) : local;

async function vendorAddress(vendor: VendorConfig): Promise<string> {
  const setting = passwordSetting(vendor);
  values[setting] ||= randomBytes(24).toString("base64url");
  const credentials = { name: vendor.name, email: `${vendor.slug}@stores.mandate.test`, password: values[setting]! };
  const post = (path: string) => fetch(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(credentials), signal: AbortSignal.timeout(180_000) });
  let response = await post("/api/auth/login");
  if (response.status === 401) response = await post("/api/auth/register");
  if (!response.ok) throw new Error(`Could not open the ${vendor.name} account (${response.status}). Is pnpm dev running?`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const workspace = await (await fetch(`${api}/api/workspace`, { headers: { cookie }, signal: AbortSignal.timeout(180_000) })).json() as { accounts: { address?: string; verified?: boolean }[] };
  const account = workspace.accounts[0];
  if (!account?.address || !account.verified) throw new Error(`${vendor.name} has no verified smart account yet. Run this again in a minute.`);
  // List it, so teams can pick it by name when they set up a purchasing workflow.
  const listed = await fetch(`${api}/api/profile`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ vendor: { name: vendor.name, category: vendor.category } }), signal: AbortSignal.timeout(60_000) });
  if (!listed.ok) throw new Error(`Could not list ${vendor.name} in the vendor directory (${listed.status})`);
  return account.address;
}

const network = await (await fetch(`${api}/api/network`)).json() as { network: { tokenContract: string } };
values.MERCHANT_ASSET = network.network.tokenContract;
const verified = vendors.filter(vendor => !vendor.looksLike);
for (const vendor of verified) values[addressSetting(vendor)] = await vendorAddress(vendor);
// A contract address nobody registered: it looks like a vendor but is not verified.
values.STORE_LOOKALIKE_ADDRESS ||= StrKey.encodeContract(randomBytes(32));
const summary = `Vendors ready: ${verified.map(vendor => `${vendor.name} ${values[addressSetting(vendor)]}`).join(", ")}, look-alike ${values.STORE_LOOKALIKE_ADDRESS} (not verified).`;
if (settingsFile) {
  // Only what this script manages, so settings for vendors that no longer exist are dropped.
  const managed = ["MERCHANT_ASSET", ...verified.flatMap(vendor => [addressSetting(vendor), passwordSetting(vendor)]), "STORE_LOOKALIKE_ADDRESS"];
  writeFileSync(settingsFile, `${managed.map(name => `${name}=${values[name]}`).join("\n")}\n`, { mode: 0o600 });
  chmodSync(settingsFile, 0o600);
  console.log(summary);
  console.log(`No secrets were printed. Load ${settingsFile} into that deployment and restart it.`);
  process.exit(0);
}
if (!values.FACILITATOR_SECRET) {
  values.FACILITATOR_SECRET = Keypair.random().secret();
}
const facilitator = Keypair.fromSecret(values.FACILITATOR_SECRET).publicKey();
const funded = await fetch(`${values.PAYMENTS_HORIZON_URL}/accounts/${facilitator}`);
if (!funded.ok) {
  const response = await fetch(`${values.PAYMENTS_FRIENDBOT_URL}?addr=${facilitator}`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error("Could not fund the facilitator on Stellar testnet");
}
writeConfiguration(values);
console.log(summary);
console.log("No secrets were printed. Restart pnpm dev so the stores and facilitator pick them up.");
