// Stages the pitch demo on the running API: a builder's account with two
// agents that hold their own keys, a mandate each, real x402 purchases from
// the demo sellers and the attempts the account refuses.
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
  agents?: { id: string; name: string; status?: string; publicKey?: string }[];
  mandates?: { id: string; name: string; status?: string }[];
}

const credentials = { name: "Tobi Adeyemi", email: "tobi@studio.mandate.test", password: values.DEMO_OWNER_PASSWORD };
try { await owner("POST", "/api/auth/login", credentials); } catch (error) {
  if ((error as { status?: number }).status !== 401) throw error;
  await owner("POST", "/api/auth/register", credentials);
  console.log("Opened the demo owner account (Tobi Adeyemi).");
}
let workspace = await owner<Workspace>("GET", "/api/workspace");
const account = workspace.accounts[0];
if (!account?.address || !account.verified) throw new Error("The owner's smart account is not ready yet. Run this again in a minute.");
if (Number(account.balance ?? 0) < 100) {
  await owner("POST", `/api/accounts/${account.id}/funding`, { method: "testnet", amount: "250", requestId: randomUUID() });
  console.log("Added $250 of testnet USD.");
}

const catalog = await (await fetch(`${storesUrl}/catalog`)).json() as { stores: { slug: string; payTo: string; items: { id: string; url: string }[] }[] };
const url = (store: string, item: string) => {
  const found = catalog.stores.find((entry) => entry.slug === store)?.items.find((entry) => entry.id === item);
  if (!found) throw new Error(`The sellers have no ${store}/${item}. Run pnpm setup:stores and restart the sellers.`);
  return found.url;
};
const payTo = (store: string) => catalog.stores.find((entry) => entry.slug === store)!.payTo;

// One key file per deployment, so staging the hosted demo keeps the local agents connected.
const host = new URL(api).host;
const keyFile = (name: string) => /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? `${name}.json` : `${name}-${host.replace(/[^a-z0-9.-]/gi, "_")}.json`;

async function connectedAgent(name: string, file: string): Promise<{ id: string; agent: MandateAgent }> {
  const agent = new MandateAgent({ file: join(homedir(), ".mandate", keyFile(file)), apiUrl: api });
  const existing = workspace.agents?.find((entry) => entry.name === name);
  if (existing) {
    try { await agent.mandates(); return { id: existing.id, agent }; } catch { /* not connected with this key file: connect again below */ }
  }
  const waiting = existing
    ? { id: existing.id, pairing: await owner<{ code: string }>("POST", `/api/agents/${existing.id}/pairing`) }
    : await owner<{ id: string; pairing: { code: string } }>("POST", "/api/agents", { name, requestId: randomUUID(), connect: true });
  await agent.connect(waiting.pairing.code);
  console.log(`${name} connected with its own key.`);
  return { id: waiting.id, agent };
}

async function mandate(name: string, agentId: string, agent: MandateAgent, limit: string, store: string) {
  if (workspace.mandates?.some((entry) => entry.name === name && entry.status !== "revoked")) return;
  const seller = await agent.checkSeller(payTo(store));
  if (!seller.verified || !seller.sellerId) throw new Error(`${store} is not a verified seller on this API. Run pnpm setup:stores against it.`);
  await owner("POST", "/api/mandates", { name, agentId, limit, period: "week", expiresAt: new Date("2026-12-31T23:59:00Z").toISOString(), sellerIds: [seller.sellerId], requestId: randomUUID() });
  console.log(`Granted "${name}": $${limit} a week, ${store} only.`);
}

const research = await connectedAgent("Research agent", "demo-research");
const coding = await connectedAgent("Coding agent", "demo-coding");
workspace = await owner<Workspace>("GET", "/api/workspace");
await mandate("Research data", research.id, research.agent, "50", "atlas");
await mandate("Compute budget", coding.id, coding.agent, "40", "forge");

const staged = !process.argv.includes("--again") && (workspace as unknown as { activity?: { kind: string }[] }).activity?.filter((entry) => entry.kind === "payment").length;
if (staged) {
  console.log("Purchases already staged. Pass --again to make more.");
} else {
  const buys: [MandateAgent, string, string, string][] = [
    [research.agent, "atlas", "lookup", "Lead list for outreach"],
    [coding.agent, "forge", "gpu-hour", "Fine-tune run"],
    [research.agent, "atlas", "search", "Market scan"],
    [coding.agent, "forge", "transcribe", "Customer call notes"],
    [research.agent, "atlas", "news", "Competitor news"],
    [coding.agent, "forge", "gpu-hour", "Eval run"],
  ];
  for (const [agent, store, item, reference] of buys) {
    const result = await agent.buy(url(store, item), { reference });
    console.log(`${reference}: ${result.status}${result.status === "declined" ? ` (${result.reason})` : ""}`);
  }
  // What the account refuses, so the owner sees the declines.
  const refusals: [MandateAgent, string, string, string][] = [
    [research.agent, "atlass", "lookup", "Look-alike seller"],
    [research.agent, "atlas", "export", "Over the weekly limit"],
    [coding.agent, "atlas", "lookup", "Seller not on its list"],
  ];
  for (const [agent, store, item, label] of refusals) {
    const result = await agent.buy(url(store, item));
    console.log(`${label}: ${result.status}${result.status === "declined" ? ` (${result.reason})` : ""}`);
  }
}
console.log(`Done. Sign in as ${credentials.email}; the password is DEMO_OWNER_PASSWORD in .env.`);
