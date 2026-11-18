// Stages the pitch demo on the running API: the Operations team at a
// mid-sized logistics company, with two purchasing workflows. Each workflow is
// an agent that holds its own key and a mandate for one approved vendor. Then
// real x402 purchases from the demo vendors, and the attempts the account
// refuses.
//
//   pnpm stage:demo          (API and sellers running, after pnpm setup:stores)
//
// Set PAYMENTS_API_URL to stage another deployment. The owner login is a test
// value for this demo only: it is kept in .env and never printed. Agent keys
// live in ~/.mandate/demo-*.json. Running it again reuses everything and only
// adds what is missing.
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { MandateAgent } from "../apps/agent/src/client.ts";
import { readConfiguration, writeConfiguration } from "./config.ts";

const values = readConfiguration();
const api = process.env.PAYMENTS_API_URL || values.PAYMENTS_API_URL || "http://localhost:4022";
const storesUrl = process.env.STORES_URL || values.STORES_URL || "http://localhost:4021";
if (!values.DEMO_OWNER_PASSWORD) {
  values.DEMO_OWNER_PASSWORD = randomBytes(18).toString("base64url");
  // pnpm dev restarts when .env changes, so wait for the API to come back.
  writeConfiguration(values);
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
for (let attempt = 0; attempt < 60; attempt++) {
  const up = await fetch(`${api}/api/network`, { signal: AbortSignal.timeout(2000) }).then((response) => response.ok, () => false);
  if (up) break;
  if (attempt === 59) throw new Error(`The API at ${api} is not answering. Is pnpm dev running?`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

let cookie = "";
async function owner<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${api}${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(240_000) });
  cookie = response.headers.get("set-cookie")?.split(";")[0] || cookie;
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw Object.assign(new Error(`${method} ${path}: ${response.status} ${result.error ?? ""}`), { status: response.status });
  return result;
}

interface Workspace {
  accounts: { id: string; address?: string; verified?: boolean; balance?: string }[];
  agents?: { id: string; name: string; status?: string; publicKey?: string; pairing?: { code: string } }[];
  mandates?: { reference: string; name: string; status?: string; limit: string }[];
  vendors?: { sellerId: number; name: string }[];
  activity?: { kind: string }[];
}

const credentials = { name: "Dana Okafor", email: "dana@larkfield.mandate.test", password: values.DEMO_OWNER_PASSWORD, company: "Larkfield Logistics", team: "Operations" };
try { await owner("POST", "/api/auth/login", credentials); } catch (error) {
  if ((error as { status?: number }).status !== 401) throw error;
  await owner("POST", "/api/auth/register", credentials);
  console.log("Opened the demo workspace (Dana Okafor, Operations at Larkfield Logistics).");
}
let workspace = await owner<Workspace>("GET", "/api/workspace");
const account = workspace.accounts[0];
if (!account?.address || !account.verified) throw new Error("The owner's smart account is not ready yet. Run this again in a minute.");
if (Number(account.balance ?? 0) < 500) {
  await owner("POST", `/api/accounts/${account.id}/funding`, { method: "testnet", amount: "5000", requestId: randomUUID() });
  console.log("Added $5,000 of testnet USD.");
}

const catalog = await (await fetch(`${storesUrl}/catalog`)).json() as { stores: { slug: string; name: string; payTo: string; items: { id: string; url: string }[] }[] };
const url = (store: string, item: string) => {
  const found = catalog.stores.find((entry) => entry.slug === store)?.items.find((entry) => entry.id === item);
  if (!found) throw new Error(`The vendors have no ${store}/${item}. Run pnpm setup:stores and restart them.`);
  return found.url;
};

// One key file per deployment, so staging the hosted demo keeps the local agents connected.
const host = new URL(api).host;
const keyFile = (name: string) => /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? `${name}.json` : `${name}-${host.replace(/[^a-z0-9.-]/gi, "_")}.json`;

/**
 * A purchasing workflow, the way the dashboard creates one: the agent and its
 * drafted mandate first, then the agent connects with its own key and the
 * mandate goes on chain.
 */
async function workflow(name: string, category: string, limit: string, period: "week" | "month", vendor: string, file: string): Promise<MandateAgent> {
  const agent = new MandateAgent({ file: join(homedir(), ".mandate", keyFile(file)), apiUrl: api });
  const agentName = `${name} agent`;
  const existing = workspace.agents?.find((entry) => entry.name === agentName && entry.status !== "revoked");
  if (existing?.status === "connected") {
    try { await agent.mandates(); return agent; } catch { throw new Error(`${agentName} is connected with a key this computer does not have. Remove it in the dashboard and run this again.`); }
  }
  const listed = workspace.vendors?.find((entry) => entry.name === vendor);
  if (!listed) throw new Error(`${vendor} is not in the vendor directory on this API. Run pnpm setup:stores against it.`);
  const waiting = existing?.pairing?.code ? existing : await owner<{ id: string; pairing: { code: string } }>("POST", "/api/workflows", {
    name, category, limit, period, expiresAt: new Date("2027-03-31T23:59:00Z").toISOString(), sellerIds: [listed.sellerId], requestId: randomUUID(),
  });
  await agent.connect(waiting.pairing!.code);
  console.log(`${name}: its agent connected with its own key and got $${limit} a ${period}, ${vendor} only.`);
  return agent;
}

const software = await workflow("Software renewals", "Software", "300", "month", "Seatwise", "demo-software");
const supplies = await workflow("Office supplies", "Office supplies", "200", "week", "Paperline Supply", "demo-supplies");
workspace = await owner<Workspace>("GET", "/api/workspace");

const staged = !process.argv.includes("--again") && workspace.activity?.some((entry) => entry.kind === "payment");
if (staged) {
  console.log("Purchases already staged. Pass --again to make more.");
} else {
  const buys: [MandateAgent, string, string, string][] = [
    [software, "seatwise", "tracker-seat", "Project tracker seat for the new dispatcher"],
    [supplies, "paperline", "copy-paper", "Warehouse printer paper, weekly restock"],
    [software, "seatwise", "password-manager", "Password manager renewal"],
    [supplies, "paperline", "labels", "Shipping labels, low stock"],
    [software, "seatwise", "design-seat", "Design seat for marketing"],
    [supplies, "paperline", "toner", "Toner for the dock office printer"],
  ];
  for (const [agent, store, item, reference] of buys) {
    const result = await agent.buy(url(store, item), { reference });
    console.log(`${reference}: ${result.status}${result.status === "declined" ? ` (${result.reason})` : ""}`);
  }
  // What the account refuses, so the team sees the declines.
  const refusals: [MandateAgent, string, string, string][] = [
    [supplies, "paperline-suply", "copy-paper", "Cheapest copy paper offer"],
    [software, "seatwise", "annual-plan", "Annual plan to save on seats"],
    [supplies, "seatwise", "tracker-seat", "Tracker seat for the supplies desk"],
  ];
  for (const [agent, store, item, reference] of refusals) {
    const result = await agent.buy(url(store, item), { reference });
    console.log(`${reference}: ${result.status}${result.status === "declined" ? ` (${result.reason})` : ""}`);
  }
}
console.log(`Done. Sign in as ${credentials.email}; the password is DEMO_OWNER_PASSWORD in .env.`);
