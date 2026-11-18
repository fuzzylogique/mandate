// End-to-end on Stellar testnet: an agent that holds its own key, paying
// directly and over x402, against everything a mandate must refuse.
//
//   pnpm test:agents          (API running, after pnpm setup:stores)
//
// Starts the demo stores and facilitator itself unless STORES_URL answers.
// Uses a throwaway owner and a temporary agent key file.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { MandateAgent } from "../apps/agent/src/client.ts";
import { createPayingFetch } from "../apps/agent/src/purchase.ts";
import { readConfiguration } from "./config.ts";

const values = { ...readConfiguration(), ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")) };
const api = values.PAYMENTS_API_URL || "http://localhost:4022";
const storesUrl = values.STORES_URL || "http://localhost:4021";
const root = fileURLToPath(new URL("../", import.meta.url));
const children: ChildProcess[] = [];
const directory = mkdtempSync(join(tmpdir(), "mandate-live-agent-"));

const up = async (url: string) => { try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
async function start(app: string, health: string) {
  if (await up(health)) return;
  const child = spawn("node", ["--env-file-if-exists=../../.env", "src/index.ts"], { cwd: join(root, "apps", app), env: process.env, stdio: ["ignore", "ignore", "inherit"] });
  children.push(child);
  for (let i = 0; i < 60 && !await up(health); i++) await new Promise(resolve => setTimeout(resolve, 500));
  assert.ok(await up(health), `${app} did not start`);
}

let cookie = "";
async function owner<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${api}${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(180_000) });
  cookie = response.headers.get("set-cookie")?.split(";")[0] || cookie;
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${result.error ?? ""}`);
  return result;
}
const step = (label: string) => console.log(`\n▸ ${label}`);
const declined = (result: { status: string; reason?: string }, why: RegExp | string) => {
  assert.equal(result.status, "declined", `expected a decline, got ${JSON.stringify(result)}`);
  console.log(`  declined: ${result.reason}`);
  if (why) assert.match(result.reason!, typeof why === "string" ? new RegExp(why, "i") : why);
};

try {
  await start("facilitator", `${values.FACILITATOR_URL || "http://localhost:4023"}/supported`);
  await start("merchant", `${storesUrl}/health`);
  const catalog = await (await fetch(`${storesUrl}/catalog`)).json() as { stores: { slug: string; payTo: string; items: { id: string; price: string; url: string }[] }[] };
  const url = (store: string, item: string) => catalog.stores.find(s => s.slug === store)!.items.find(i => i.id === item)!.url;

  step("Owner signs up and adds $100 of testnet USD");
  await owner("POST", "/api/auth/register", { name: "Live agent owner", email: `live-${randomBytes(6).toString("hex")}@example.com`, password: randomBytes(18).toString("base64url") });
  let workspace = await owner<{ accounts: { id: string; address: string }[] }>("GET", "/api/workspace");
  const account = workspace.accounts[0]!;
  await owner("POST", `/api/accounts/${account.id}/funding`, { method: "testnet", amount: "100", requestId: randomUUID() });

  step("Owner adds an agent; the agent connects with the code and its own key");
  const waiting = await owner<{ id: string; pairing: { code: string } }>("POST", "/api/agents", { name: "Live shopper", requestId: randomUUID(), connect: true });
  const agent = new MandateAgent({ file: join(directory, "agent.json"), apiUrl: api });
  const connection = await agent.connect(waiting.pairing.code);
  assert.equal(connection.agentId, waiting.id);
  assert.equal(connection.smartAccount, account.address);
  console.log(`  connected ${connection.agentId} with key ${agent.publicKey}`);

  step("Owner grants $40 a day, Seatwise only");
  const seatwise = await agent.checkSeller(values.STORE_SEATWISE_ADDRESS!);
  assert.ok(seatwise.verified && seatwise.sellerId, "Seatwise must be a verified Mandate seller. Run pnpm setup:stores against this API.");
  const granted = await owner<{ mandate: { reference: string }; mandateId?: string }>("POST", "/api/mandates", { name: "Software seats", agentId: waiting.id, limit: "40", period: "day", expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), sellerIds: [seatwise.sellerId], category: "Software", requestId: randomUUID() });
  assert.equal(granted.mandateId, undefined, "an agent-held mandate has no secret ID");

  step("Pays Seatwise $1 directly, signed with its own key");
  const direct = await agent.pay({ seller: values.STORE_SEATWISE_ADDRESS!, amount: "1", reference: "Seat top-up", requestId: randomUUID() });
  assert.equal(direct.status, "paid", JSON.stringify(direct));
  console.log(`  paid: ${direct.status === "paid" && direct.payment.explorerUrl}`);

  step("Buys a project tracker seat from Seatwise over x402 ($12)");
  const bought = await agent.buy(url("seatwise", "tracker-seat"), { reference: "Project tracker seat" });
  assert.equal(bought.status, "paid", JSON.stringify(bought));
  console.log(`  paid: ${bought.status === "paid" && bought.payment.explorerUrl}`);
  assert.equal((await agent.mandates())[0]!.remaining, "27");

  step("Refused: Paperline Supply is verified but not allowed (service, then chain via x402)");
  declined(await agent.pay({ seller: values.STORE_PAPERLINE_ADDRESS!, amount: "1", reference: "Labels", requestId: randomUUID() }), "allowed seller");
  declined(await agent.buy(url("paperline", "labels")), "allowed seller");

  step("Refused: the look-alike seller is not verified");
  declined(await agent.pay({ seller: values.STORE_LOOKALIKE_ADDRESS!, amount: "1", reference: "Labels", requestId: randomUUID() }), "verified");
  declined(await agent.buy(url("paperline-suply", "labels")), "verified");

  step("Refused: over the limit");
  declined(await agent.pay({ seller: values.STORE_SEATWISE_ADDRESS!, amount: "28", reference: "Too many seats", requestId: randomUUID() }), "limit");
  declined(await agent.buy(url("seatwise", "password-manager")), "limit");

  step("Owner raises the limit to $60 a day on chain; the same purchase now goes through");
  await owner("PATCH", `/api/mandates/${granted.mandate.reference}`, { limit: "60", requestId: randomUUID() });
  assert.equal((await agent.mandates())[0]!.remaining, "47");
  const afterRaise = await agent.buy(url("seatwise", "password-manager"), { reference: "Password manager renewal" });
  assert.equal(afterRaise.status, "paid", JSON.stringify(afterRaise));
  console.log(`  paid: ${afterRaise.status === "paid" && afterRaise.payment.explorerUrl}`);

  step("Owner lowers the limit to $50 a day; nothing more fits");
  await owner("PATCH", `/api/mandates/${granted.mandate.reference}`, { limit: "50", requestId: randomUUID() });
  declined(await agent.buy(url("seatwise", "tracker-seat")), "limit");

  step("Refused: a different key cannot act as this agent");
  const stranger = new MandateAgent({ file: join(directory, "stranger.json"), apiUrl: api });
  await assert.rejects(stranger.connect(waiting.pairing.code), /not valid/);
  (stranger as unknown as { data: { connection: unknown } }).data.connection = connection;
  await assert.rejects(stranger.mandates(), /not connected/);
  console.log("  rejected by Mandate");
  // Going around Mandate: sign the x402 payment as this agent with another key. The verifier checks the registry.
  const ruleId = (await agent.mandates())[0]!.ruleId;
  const bypass = (secret: string) => createPayingFetch({ payer: { mode: "smart-account", agentSecret: secret, agentId: connection.agentId, smartAccount: connection.smartAccount, contextRuleId: ruleId, verifier: connection.agentVerifier }, extraAsset: connection.asset });
  await assert.rejects(bypass(Keypair.random().secret())(url("seatwise", "tracker-seat")), /refused/);
  console.log("  rejected on chain");

  step("Owner removes the agent; it can no longer pay");
  await owner("DELETE", `/api/agents/${waiting.id}`);
  await assert.rejects(agent.mandates(), /removed/);
  console.log("  rejected by Mandate");
  // Going around Mandate with the agent's real key and old rule: the rule and registration are gone on chain.
  const ownKey = (agent as unknown as { data: { secret: string } }).data.secret;
  await assert.rejects(bypass(ownKey)(url("seatwise", "tracker-seat")), /refused/);
  console.log("  rejected on chain");

  workspace = await owner("GET", "/api/workspace");
  const activity = (workspace as unknown as { activity: { kind: string; agentId?: string; amount: string }[] }).activity.filter(e => e.kind === "payment");
  assert.deepEqual(activity.map(e => e.amount).sort(), ["1", "12", "40"]);
  assert.ok(activity.every(e => e.agentId === waiting.id));
  const declines = (workspace as unknown as { declines: { reason: string; agentId: string }[] }).declines;
  assert.equal(declines.length, 7, "every refused attempt is kept for the owner");
  assert.ok(declines.every(e => e.agentId === waiting.id));
  console.log("\n✓ Agent with its own key: 3 payments made, 10 refused (6 of them by the account on chain, with Mandate skipped), limit raised and lowered on chain by the owner, revoked agent blocked on chain.");
} finally {
  for (const child of children) child.kill();
  rmSync(directory, { recursive: true, force: true });
}
