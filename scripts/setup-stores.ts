// Sets up the x402 demo: two stores that are real Mandate accounts (so their
// smart accounts are verified sellers), one look-alike that is not, and a
// facilitator key that submits x402 payments and pays their fees.
//
// Run with the API up (pnpm dev). Store logins are test values for this demo
// only; they are kept in .env and never printed.
import { randomBytes } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { readConfiguration, writeConfiguration } from "./config.ts";

const values = readConfiguration();
const api = process.env.PAYMENTS_API_URL || values.PAYMENTS_API_URL || "http://localhost:4022";

async function storeAddress(slug: string, name: string): Promise<string> {
  const setting = `STORE_${slug.toUpperCase()}_PASSWORD`;
  values[setting] ||= randomBytes(24).toString("base64url");
  const credentials = { name, email: `${slug}@stores.mandate.test`, password: values[setting]! };
  const post = (path: string) => fetch(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(credentials), signal: AbortSignal.timeout(180_000) });
  let response = await post("/api/auth/login");
  if (response.status === 401) response = await post("/api/auth/register");
  if (!response.ok) throw new Error(`Could not open the ${name} account (${response.status}). Is pnpm dev running?`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const workspace = await (await fetch(`${api}/api/workspace`, { headers: { cookie }, signal: AbortSignal.timeout(180_000) })).json() as { accounts: { address?: string; verified?: boolean }[] };
  const account = workspace.accounts[0];
  if (!account?.address || !account.verified) throw new Error(`${name} has no verified smart account yet. Run this again in a minute.`);
  return account.address;
}

const network = await (await fetch(`${api}/api/network`)).json() as { network: { tokenContract: string } };
values.MERCHANT_ASSET = network.network.tokenContract;
values.STORE_FRESHMART_ADDRESS = await storeAddress("freshmart", "FreshMart");
values.STORE_GREENLEAF_ADDRESS = await storeAddress("greenleaf", "GreenLeaf Market");
// A contract address nobody registered: it looks like a store but is not a verified seller.
values.STORE_LOOKALIKE_ADDRESS ||= StrKey.encodeContract(randomBytes(32));
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
console.log(`Stores ready: FreshMart ${values.STORE_FRESHMART_ADDRESS}, GreenLeaf ${values.STORE_GREENLEAF_ADDRESS}, look-alike ${values.STORE_LOOKALIKE_ADDRESS} (not verified).`);
console.log("No secrets were printed. Restart pnpm dev so the stores and facilitator pick them up.");
