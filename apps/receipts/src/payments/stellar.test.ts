import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type { PaymentNetwork, SpendingPeriod } from "@mandate/shared";
import { StellarPaymentService } from "./stellar-service.ts";
import { StellarGateway, stellarConfig, type ChainGateway, type ChainWallet } from "./stellar.ts";
import { ServiceError, WorkspaceStore } from "./store.ts";
import { createPaymentApp } from "./http.ts";

/** Fake network for service tests. It owns balances; the service cannot create money. */
class TestChain implements ChainGateway {
  network: PaymentNetwork = { id: "stellar:testnet", name: "Test chain", rpcUrl: "https://rpc.example", horizonUrl: "https://horizon.example", explorerUrl: "https://explorer.example", currency: "XLM", tokenContract: StrKey.encodeContract(randomBytes(32)), smartAccounts: true, verifiedSmartAccounts: true, mandates: true, agentVerification: true, faucet: true };
  verified = new Set<string>();
  agents = new Map<string, string>();
  async registerAgent(_id: string, account: ChainWallet, agentId: string, name: string) {
    if (this.fail) throw new Error("Registry unavailable");
    this.agents.set(`${account.address}:${agentId}`, name); return this.receipt();
  }
  async isVerifiedAgent(account: string, agentId: string) { return this.agents.has(`${account}:${agentId}`); }
  wallets = new Map<string, ChainWallet>();
  balances = new Map<string, bigint>();
  usdBalances = new Map<string, bigint>();
  private assetBalances(currency = "XLM") { return currency === "USD" ? this.usdBalances : this.balances; }
  values = new Map<string, string>();
  commands = new Map<string, { fingerprint: string; result: unknown }>();
  rules = new Map<number, { accountId: string; currency: string; limit: bigint; spent: bigint; revoked: boolean; expiresAt: string; periodMs: number; history: { amount: bigint; time: number }[] }>();
  transfers: { source: string; destination: string; amount: bigint; ruleId?: number; currency: string }[] = [];
  owners = new Map<string, string>();
  deposits: { destination: string; amount: bigint; currency: string }[] = [];
  transactions = new Map<string, { txHash: string }>();
  failFunding = false;
  hasTransaction(id: string) { return this.transactions.has(id); }
  async deposit(id: string, wallet: ChainWallet, units: bigint, currency = "XLM") {
    const key = `deposit:${id}`;
    if (this.transactions.has(key)) return this.transactions.get(key)!;
    if (this.fail) throw new Error("Deposit unavailable");
    this.assetBalances(currency).set(wallet.address, await this.balance(wallet, currency) + units);
    this.deposits.push({ destination: wallet.address, amount: units, currency });
    const receipt = this.receipt(); this.transactions.set(key, receipt); return receipt;
  }
  fail = false;
  pending = false;
  nextRule = 1;
  private receipt() { return { txHash: randomBytes(32).toString("hex") }; }
  close() {}
  treasury(id: string): ChainWallet {
    if (!this.wallets.has(id)) this.wallets.set(id, { id, address: Keypair.random().publicKey(), rail: "classic" });
    return this.wallet(id);
  }
  wallet(id: string): ChainWallet { const found = this.wallets.get(id); if (!found) throw new ServiceError(409, "Wallet not found"); return found; }
  secret(id: string, generate: () => string) { if (!this.values.has(id)) this.values.set(id, generate()); return this.values.get(id)!; }
  async command<T>(id: string, input: unknown, work: () => Promise<T>): Promise<T> {
    const fingerprint = JSON.stringify(input);
    const existing = this.commands.get(id);
    if (existing) { if (existing.fingerprint !== fingerprint) throw new ServiceError(409, "Idempotency key was used with different details"); if (existing.result !== undefined) return existing.result as T; }
    this.commands.set(id, { fingerprint, result: undefined });
    const result = await work(); this.commands.set(id, { fingerprint, result }); return result;
  }
  async balance(wallet: ChainWallet, currency = "XLM") { return this.assetBalances(currency).get(wallet.address) ?? 0n; }
  async isVerifiedSmartAccount(address: string) { return StrKey.isValidContract(address) && this.verified.has(address); }
  async verifySmartAccount(_id: string, wallet: ChainWallet) { assert.equal(wallet.rail, "blockchain"); this.verified.add(wallet.address); return this.receipt(); }
  async faucet(wallet: ChainWallet) { if (!this.balances.has(wallet.address)) this.balances.set(wallet.address, 1_000_000_000n); return { ...this.receipt(), amount: "100" }; }
  async createAccount(id: string, treasury: ChainWallet) {
    if (this.fail) throw new Error("Network unavailable");
    if (this.wallets.has(id)) return { ...this.wallet(id), ...this.receipt() };
    const wallet: ChainWallet = { id, address: StrKey.encodeContract(randomBytes(32)), rail: "blockchain" };
    this.owners.set(id, treasury.id);
    this.wallets.set(id, wallet); return { ...wallet, ...this.receipt() };
  }
  async transfer(_id: string, _treasury: ChainWallet, source: ChainWallet, destination: string, units: bigint, mandate?: { id: string; ruleId: number; agentId?: string }, currency = "XLM") {
    if (this.transactions.has(_id)) return this.transactions.get(_id)!;
    if (this.fail || (this.failFunding && source.rail === "classic")) throw new Error("Network unavailable");
    if (source.rail === "blockchain") assert.equal(_treasury.id, this.owners.get(source.id), "The linked Classic wallet must sign");
    if (this.pending) throw new ServiceError(503, "Awaiting network confirmation", "ab".repeat(32));
    assert.ok(await this.balance(source, currency) >= units, "Network rejected insufficient funds");
    if (source.rail === "blockchain") assert.ok(await this.isVerifiedSmartAccount(destination), "Contract rejected recipient");
    if (mandate) {
      assert.ok(mandate.agentId && await this.isVerifiedAgent(source.address, mandate.agentId), "Contract rejected unregistered agent");
      assert.ok(await this.isVerifiedSmartAccount(destination), "Contract rejected unverified smart recipient");
      const rule = this.rules.get(mandate.ruleId)!;
      assert.equal(rule.accountId, source.id); assert.equal(rule.currency, currency);
      assert.ok(!rule.revoked && Date.parse(rule.expiresAt) > Date.now() && await this.spent(source, mandate.ruleId) + units <= rule.limit, "Contract rejected mandate");
      rule.history.push({ amount: units, time: Date.now() }); rule.spent += units;
    }
    this.assetBalances(currency).set(source.address, await this.balance(source, currency) - units);
    this.assetBalances(currency).set(destination, (this.assetBalances(currency).get(destination) ?? 0n) + units);
    this.transfers.push({ source: source.address, destination, amount: units, ruleId: mandate?.ruleId, currency });
    const receipt = this.receipt(); this.transactions.set(_id, receipt); return receipt;
  }
  async addMandate(_id: string, _treasury: ChainWallet, _account: ChainWallet, input: { limit: bigint; name: string; period: SpendingPeriod; expiresAt: string; currency?: string }) {
    assert.equal(_treasury.id, this.owners.get(_account.id));
    if (this.fail) throw new Error("Network unavailable");
    const ruleId = this.nextRule++; this.rules.set(ruleId, { accountId: _account.id, currency: input.currency ?? "XLM", limit: input.limit, spent: 0n, revoked: false, expiresAt: input.expiresAt, periodMs: { day: 86400_000, week: 7 * 86400_000, month: 30 * 86400_000 }[input.period], history: [] }); return { ...this.receipt(), ruleId };
  }
  async revokeMandate(_id: string, _treasury: ChainWallet, _account: ChainWallet, ruleId: number) { if (this.fail) throw new Error("Network unavailable"); assert.equal(_treasury.id, this.owners.get(_account.id)); this.rules.get(ruleId)!.revoked = true; return this.receipt(); }
  async spent(_account: ChainWallet, ruleId: number) { const rule = this.rules.get(ruleId)!; return rule.history.filter(entry => entry.time > Date.now() - rule.periodMs).reduce((sum, entry) => sum + entry.amount, 0n); }
}
async function fixture(path = ":memory:") {
  const chain = new TestChain(); const service = new StellarPaymentService(path, chain);
  const registered = await service.register({ name: "Chain owner", email: "owner@example.com", password: "long chain password" });
  const owner = service.authenticate(registered.token);
  const agent = await service.createAgent(owner, { name: "Buyer", requestId: "buyer" });
  return { chain, service, owner, agentId: agent.id, token: registered.token };
}

async function sellerAccount(service: StellarPaymentService) {
  const result = await service.register({ name: "Seller", email: `seller-${randomBytes(8).toString("hex")}@example.com`, password: "a secure seller password" });
  return (await service.workspace(service.authenticate(result.token))).accounts[0]!;
}

test("signup creates a unique registered chat agent and login reuses it", async () => {
  const chain = new TestChain();
  const service = new StellarPaymentService(":memory:", chain);
  try {
    const credentials = { name: "Chat owner", email: "chat@example.com", password: "a secure chat password" };
    const created = await service.register(credentials);
    const owner = service.authenticate(created.token);
    const workspace = await service.workspace(owner);
    assert.equal(workspace.agents.length, 1);
    const agent = workspace.agents[0]!;
    assert.equal(workspace.mandates.length, 1);
    const defaultMandate = workspace.mandates[0]!;
    assert.equal(defaultMandate.name, "Chat mandate");
    assert.equal(defaultMandate.limit, "1");
    assert.equal(defaultMandate.currency, "USD");
    assert.equal(defaultMandate.period, "day");
    assert.equal(defaultMandate.recipient, agent.id);
    assert.equal(defaultMandate.enforcement, "on-chain");
    assert.ok(Math.abs(Date.parse(defaultMandate.expiresAt) - Date.now() - 30 * 86400_000) < 1000);
    assert.equal(agent.name, "Chat agent");
    assert.equal(agent.accountId, workspace.accounts[0]!.id);
    assert.equal(agent.verified, true);
    assert.ok(agent.verificationTxHash);
    assert.ok(await chain.isVerifiedAgent(workspace.accounts[0]!.address!, agent.id));
    const login = await service.login(credentials);
    assert.equal((await service.defaultChatAgent(service.authenticate(login.token))).id, agent.id);
    assert.equal((await service.workspace(owner)).agents.length, 1);
    assert.equal((await service.workspace(owner)).mandates.length, 1);
    const other = await service.register({ ...credentials, email: "chat-other@example.com" });
    assert.notEqual((await service.defaultChatAgent(service.authenticate(other.token))).id, agent.id);
  } finally { service.close(); }
});

test("an existing signed-in dashboard creates missing chat defaults once across concurrent loads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mandate-dashboard-defaults-"));
  const path = join(directory, "workspace.sqlite");
  const store = new WorkspaceStore(path);
  const chain = new TestChain();
  const service = new StellarPaymentService(path, chain);
  try {
    // A session created before chat defaults existed, with an established main account.
    const registered = await store.register({ name: "Existing owner", email: "dashboard-defaults@example.com", password: "a secure existing password" });
    const owner = service.authenticate(registered.token);
    const account = await service.createAccount(owner, { name: "Existing account", requestId: "account" });
    assert.equal(store.read().agents?.length ?? 0, 0);
    assert.equal(store.read().mandates.length, 0);
    const [first, second] = await Promise.all([service.workspace(owner), service.workspace(owner)]);
    for (const view of [first, second]) {
      assert.equal(view.agents.length, 1);
      assert.equal(view.agents[0]!.name, "Chat agent");
      assert.equal(view.agents[0]!.verified, true);
      assert.equal(view.mandates.length, 1);
      assert.equal(view.mandates[0]!.name, "Chat mandate");
      assert.equal(view.mandates[0]!.limit, "1");
      assert.equal(view.mandates[0]!.accountId, account.id);
      assert.equal(view.mandates[0]!.recipient, view.agents[0]!.id);
    }
    assert.equal(chain.agents.size, 1);
    assert.equal(chain.rules.size, 1);
    const reference = first.mandates[0]!.reference;
    const secret = service.revealMandate(owner, reference).mandateId;
    assert.equal(JSON.stringify(first).includes(secret), false);
    await service.revoke(owner, reference);
    chain.fail = true;
    const refreshed = await service.workspace(owner);
    assert.equal(refreshed.mandates[0]!.status, "revoked");
    assert.equal(refreshed.mandates.length, 1);
    assert.equal(chain.rules.size, 1);
  } finally { service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("dashboard loading finishes an interrupted default mandate setup without another login", async t => {
  const directory = mkdtempSync(join(tmpdir(), "mandate-dashboard-recovery-"));
  const path = join(directory, "workspace.sqlite");
  const store = new WorkspaceStore(path);
  const chain = new TestChain();
  const service = new StellarPaymentService(path, chain);
  try {
    const registered = await store.register({ name: "Existing owner", email: "dashboard-recovery@example.com", password: "a secure existing password" });
    const owner = service.authenticate(registered.token);
    const creation = t.mock.method(chain, "addMandate", async () => { throw new Error("Rule registration unavailable"); });
    await assert.rejects(service.workspace(owner));
    assert.equal(store.read().agents!.length, 1);
    assert.equal(store.read().mandates.length, 0);
    const expiry = store.read().customers[0]!.defaultChatMandateExpiresAt;
    creation.mock.restore();
    const view = await service.workspace(owner);
    assert.equal(view.agents.length, 1);
    assert.equal(view.mandates.length, 1);
    assert.equal(view.mandates[0]!.expiresAt, expiry);
    assert.equal(chain.agents.size, 1);
    assert.equal(chain.rules.size, 1);
  } finally { service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a failed default agent registration resumes on login without duplicating the account", async t => {
  const chain = new TestChain();
  const service = new StellarPaymentService(":memory:", chain);
  const registration = t.mock.method(chain, "registerAgent", async () => { throw new Error("Registry unavailable"); });
  try {
    const credentials = { name: "Chat owner", email: "chat-recovery@example.com", password: "a secure chat password" };
    await assert.rejects(service.register(credentials), { status: 503, message: /Sign in to resume/ });
    assert.equal(chain.wallets.size, 2);
    registration.mock.restore();
    const login = await service.login(credentials);
    const workspace = await service.workspace(service.authenticate(login.token));
    assert.equal(workspace.accounts.length, 1);
    assert.equal(workspace.agents.length, 1);
    assert.equal(workspace.agents[0]!.verified, true);
    assert.equal(chain.wallets.size, 2);
  } finally { service.close(); }
});

test("default mandate setup retries with the reserved expiry and never restores revoked access", async t => {
  const chain = new TestChain();
  const service = new StellarPaymentService(":memory:", chain);
  const creation = t.mock.method(chain, "addMandate", async () => { throw new Error("Rule registration unavailable"); });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    const credentials = { name: "Chat owner", email: "mandate-recovery@example.com", password: "a secure chat password" };
    await assert.rejects(service.register(credentials), { status: 503 });
    assert.equal(chain.wallets.size, 2);
    assert.equal(chain.agents.size, 1);
    creation.mock.restore();
    t.mock.timers.tick(3600_000);
    const login = await service.login(credentials);
    const owner = service.authenticate(login.token);
    const setup = await service.defaultChatSetup(owner);
    assert.equal(setup.mandate.limit, "1");
    assert.equal(chain.rules.size, 1);
    await service.revoke(owner, setup.mandate.reference);
    await service.login(credentials);
    assert.equal((await service.defaultChatSetup(owner)).mandate.status, "revoked");
    assert.equal(chain.rules.size, 1);
    assert.equal((await service.workspace(owner)).mandates.length, 1);
    t.mock.timers.tick(31 * 86400_000);
    const later = await service.login(credentials);
    assert.equal((await service.defaultChatSetup(service.authenticate(later.token))).mandate.status, "revoked");
    assert.equal(chain.rules.size, 1);
  } finally { service.close(); }
});

test("mandate user selection is optional and an assigned agent must belong to the account", async () => {
  const { service, owner } = await fixture();
  try {
    const input = { name: "Optional user", recipientType: "agent", limit: "1", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString() };
    const noOwner = await service.createMandate(owner, { ...input, requestId: "no-owner" });
    assert.equal(noOwner.mandate.recipient, "Any registered agent");
    const ownAgent = await service.defaultChatAgent(owner);
    const assigned = await service.createMandate(owner, { ...input, recipient: ownAgent.id, requestId: "assigned" });
    assert.equal(assigned.mandate.recipient, ownAgent.id);
    const foreign = await service.register({ name: "Other", email: "owner-option-other@example.com", password: "another secure password" });
    const foreignAgent = await service.defaultChatAgent(service.authenticate(foreign.token));
    await assert.rejects(service.createMandate(owner, { ...input, recipient: foreignAgent.id, requestId: "foreign-owner" }), { status: 400 });
    await assert.rejects(service.createMandate(owner, { ...input, recipientType: "person", requestId: "missing-email" }), { status: 400 });
  } finally { service.close(); }
});

test("HTTP chat selects the signed-in user's default agent and ignores client identity overrides", async t => {
  const { service, owner, token } = await fixture();
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  const server = createPaymentApp(service).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(async () => {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previousKey;
    await new Promise<void>(resolve => server.close(() => resolve())); service.close();
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/chat/sessions`;
  const response = await fetch(base, { method: "POST", headers: { cookie: `mandate_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ agentId: "agt_attacker" }) });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const state = await response.json() as { sessionId: string; agentId: string; mandate: { limit: string; reference: string } };
  assert.equal(state.agentId, (await service.defaultChatAgent(owner)).id);
  assert.equal(state.mandate.limit, "1");
  const setup = await service.defaultChatSetup(owner);
  assert.equal(state.mandate.reference, setup.mandate.reference);
  assert.equal(JSON.stringify(state).includes(setup.mandateId), false);
  const guest = await (await fetch(base, { method: "POST" })).json() as { agentId?: string };
  assert.equal(guest.agentId, undefined);
  const invalid = await fetch(base, { method: "POST", headers: { cookie: "mandate_session=invalid" } });
  assert.equal(invalid.status, 401);
  assert.equal((await fetch(`${base}/${state.sessionId}`)).status, 200);
  assert.equal((await fetch(`${base}/${state.sessionId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "" }) })).status, 400);
  assert.equal((await fetch(base, { method: "POST", headers: { origin: "https://other.example" } })).status, 403);
});

test("chain workspace reads external balances and configurable network metadata", async () => {
  const { chain, service, owner, agentId } = await fixture();
  try {
    const account = await service.createAccount(owner, { name: "Stellar", type: "stellar", requestId: "account" });
    chain.usdBalances.set(account.address!, 123_456_789n);
    chain.balances.set(account.address!, 999_000_000n);
    const view = await service.workspace(owner);
    assert.equal(view.mode, "stellar-testnet");
    assert.equal(view.accounts[0]!.balance, "12.3456789");
    assert.equal("parent" in view, false);
    assert.equal("balances" in view.customer, false);
    assert.equal(view.accounts[0]!.address, account.address);
    assert.equal(view.network!.rpcUrl, "https://rpc.example");
  } finally { service.close(); }
});

test("failed signup provisioning resumes the same wallet pair on login after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mandate-signup-recovery-"));
  const path = join(directory, "workspace.sqlite");
  const chain = new TestChain();
  let service = new StellarPaymentService(path, chain);
  const store = new WorkspaceStore(path);
  try {
    chain.fail = true;
    await assert.rejects(service.register({ name: "Owner", email: "recovery@example.com", password: "a secure owner password" }), { status: 503, message: /Sign in to resume/ });
    assert.equal(store.read().accounts.length, 0);
    assert.equal(store.read().sessions.length, 0);
    const reserved = store.read().customers[0]!.mainAccountId;
    assert.ok(reserved);
    await assert.rejects(service.login({ email: "recovery@example.com", password: "a secure owner password" }));
    assert.equal(store.read().sessions.length, 0);
    service.close(); service = new StellarPaymentService(path, chain);
    chain.fail = false;
    const signedIn = await service.login({ email: "recovery@example.com", password: "a secure owner password" });
    const actor = service.authenticate(signedIn.token);
    const view = await service.workspace(actor);
    assert.equal(view.accounts.length, 1);
    assert.equal(view.accounts[0]!.id, reserved);
    assert.ok(view.accounts[0]!.creationTxHash);
    assert.ok(view.accounts[0]!.verified);
    assert.equal(chain.wallets.size, 2);
    await Promise.all([service.workspace(actor), service.workspace(actor)]);
    assert.equal(chain.wallets.size, 2);
    assert.equal(store.read().stellarPairs.length, 1);
  } finally { store.close(); service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("funding and payments use network addresses and only journal confirmed receipts", async () => {
  const { chain, service, owner, agentId } = await fixture();
  try {
    const account = await service.createAccount(owner, { name: "Smart", type: "stellar", requestId: "smart" });
    const input = { amount: "10", requestId: "fund" };
    const entry = await service.fund(owner, account.id, input);
    assert.equal(entry.destination, account.address);
    assert.equal(entry.source, "Demo USD deposit");
    assert.equal(chain.deposits[0]!.destination, chain.wallet(chain.owners.get(account.id)!).address);
    assert.equal(entry.settlement, "stellar-testnet"); assert.ok(entry.txHash);
    await service.fund(owner, account.id, input);
    assert.equal(chain.transfers.length, 1);
    chain.fail = true;
    await assert.rejects(service.pay(owner, { accountId: account.id, destination: Keypair.random().publicKey(), amount: "1", reference: "Failure", requestId: "failure" }));
    assert.equal((await service.workspace(owner)).activity.length, 1); // Only completed funding is visible.
  } finally { service.close(); }
});

test("smart mandates install contract rules, sign with their rule, and revoke on chain", async () => {
  const { chain, service, owner, agentId } = await fixture();
  try {
    const account = await service.createAccount(owner, { name: "Smart", type: "stellar", requestId: "smart" });
    await service.fund(owner, account.id, { amount: "10", requestId: "fund" });
    const result = await service.createMandate(owner, { accountId: account.id, name: "Agent", recipientType: "agent", recipient: "agent", limit: "2", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "mandate" });
    assert.equal(result.mandate.enforcement, "on-chain");
    const seller = await sellerAccount(service);
    const paid = await service.payWithMandate({ agentId, mandateId: result.mandateId, amount: "1", sellerAddress: seller.address, reference: "Test", requestId: "payment" });
    assert.equal(paid.mandateReference, result.mandate.reference);
    assert.equal(chain.transfers.at(-1)!.ruleId, result.mandate.ruleId);
    const view = await service.workspace(owner); assert.equal(view.mandates.find(m => m.reference === result.mandate.reference)!.spent, "1");
    assert.equal(JSON.stringify(view).includes(result.mandateId), false);
    await service.revoke(owner, result.mandate.reference);
    assert.equal(chain.rules.get(result.mandate.ruleId!)!.revoked, true);
    await assert.rejects(service.previewMandatePayment({ agentId, mandateId: result.mandateId }), { status: 401 });
  } finally { service.close(); }
});

test("failed on-chain revocation disables service access and stays visibly retryable", async () => {
  const { chain, service, owner, agentId } = await fixture();
  try {
    const account = await service.createAccount(owner, { name: "Smart", type: "stellar", requestId: "smart" });
    const grant = await service.createMandate(owner, { accountId: account.id, name: "Agent", recipientType: "agent", recipient: "agent", limit: "1", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "mandate" });
    chain.fail = true;
    await assert.rejects(service.revoke(owner, grant.mandate.reference));
    await assert.rejects(service.previewMandatePayment({ agentId, mandateId: grant.mandateId }), { status: 401 });
    assert.equal((await service.workspace(owner)).mandates.find(m => m.reference === grant.mandate.reference)!.chainRevocationPending, true);
    assert.equal(chain.rules.get(grant.mandate.ruleId!)!.revoked, false);
    chain.fail = false;
    await service.revoke(owner, grant.mandate.reference);
    assert.equal((await service.workspace(owner)).mandates.find(m => m.reference === grant.mandate.reference)!.chainRevocationPending, false);
    assert.equal(chain.rules.get(grant.mandate.ruleId!)!.revoked, true);
  } finally { service.close(); }
});

test("a chain account and its mandates remain isolated from other customers", async () => {
  const { chain, service, owner, agentId } = await fixture();
  try {
    const account = await service.createAccount(owner, { name: "Private", type: "stellar", requestId: "private" });
    const other = await service.register({ name: "Other", email: "other@example.com", password: "other chain password" });
    const actor = service.authenticate(other.token);
    await assert.rejects(service.fund(actor, account.id, { amount: "1", requestId: "fund" }), { status: 404 });
    await assert.rejects(service.pay(actor, { accountId: account.id, amount: "1", destination: Keypair.random().publicKey(), reference: "Unauthorized", requestId: "pay" }), { status: 403 });
    assert.equal((await service.workspace(actor)).accounts.length, 1);
    assert.notEqual((await service.workspace(actor)).accounts[0]!.id, account.id);
    assert.deepEqual((await service.workspace(actor)).activity, []);
  } finally { service.close(); }
});

test("gateway encrypts keys and command responses, detects changed retries, and persists results", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mandate-vault-"));
  const path = join(directory, "chain.sqlite");
  const config = stellarConfig({ PAYMENTS_ENCRYPTION_KEY: "ab".repeat(32) });
  let gateway = new StellarGateway(path, config);
  try {
    const wallet = gateway.treasury("owner");
    const privateKey = gateway.secret("owner", () => "unused");
    const sensitive = "mnd_private_test_secret_id";
    let calls = 0;
    const run = () => gateway.command("request", { amount: "1" }, async () => { calls++; return { mandateId: sensitive }; });
    assert.equal((await run()).mandateId, sensitive); assert.equal((await run()).mandateId, sensitive); assert.equal(calls, 1);
    await assert.rejects(gateway.command("request", { amount: "2" }, async () => ({})), (error: unknown) => error instanceof ServiceError && error.status === 409);
    gateway.close();
    assert.equal(readFileSync(path).includes(Buffer.from(sensitive)), false);
    assert.equal(readFileSync(path).includes(Buffer.from(privateKey)), false);
    gateway = new StellarGateway(path, config);
    assert.equal(gateway.treasury("owner").address, wallet.address);
    assert.equal((await run()).mandateId, sensitive); assert.equal(calls, 1);
    assert.throws(() => new StellarGateway(path, { ...config, verifier: StrKey.encodeContract(randomBytes(32)) }), { status: 503 });
  } finally { gateway.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("chain configuration derives the asset contract and rejects missing encryption keys", () => {
  assert.throws(() => stellarConfig({}), { status: 503 });
  const config = stellarConfig({ PAYMENTS_ENCRYPTION_KEY: "ab".repeat(32), PAYMENTS_RPC_URL: "https://rpc.example", SMART_ACCOUNT_WASM_HASH: "12".repeat(32) });
  const gateway = new StellarGateway(":memory:", config);
  try {
    assert.equal(gateway.network.currency, "XLM"); assert.equal(gateway.network.rpcUrl, "https://rpc.example");
    assert.ok(StrKey.isValidContract(gateway.network.tokenContract));
    assert.equal(gateway.network.smartAccounts, false);
    assert.equal(gateway.network.assets!.find(asset => asset.currency === "USD")!.issuer, gateway.treasury("anchor:USD:issuer").address);
  } finally { gateway.close(); }
});

const mandateOpening = (overrides = {}) => ({ name: "Third-party purchasing", recipient: "External payer", limit: "2", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "mandate-opening", ...overrides });
async function openWithMandate(service: StellarPaymentService, owner: ReturnType<StellarPaymentService["authenticate"]>, input = mandateOpening()) {
  const account = (await service.openAccount(owner, { name: input.name, type: "stellar", requestId: input.requestId })).account;
  const grant = await service.createMandate(owner, { ...input, accountId: account.id, recipientType: "agent", type: "stellar", requestId: `grant:${input.requestId}` });
  return { account, ...grant };
}

test("legacy opening types are validated and internal wallets cannot be selected", async () => {
  const { chain, service, owner, agentId } = await fixture();
  try {
    for (const type of ["classic", "smart", "mandate"]) await assert.rejects(service.openAccount(owner, { name: "Invalid", type, requestId: type }), { status: 400 });
    const smart = (await service.openAccount(owner, { name: "Stellar", type: "stellar", requestId: "stellar" })).account;
    assert.ok(StrKey.isValidContract(smart.address!));
    assert.equal("classicAccountId" in smart, false);
    await assert.rejects(service.openAccount(owner, { name: "Override", type: "stellar", classicAccountId: chain.owners.get(smart.id), requestId: "override" }), { status: 400 });
    await assert.rejects(service.pay(owner, { accountId: smart.id, amount: "1", destination: Keypair.random().publicKey(), reference: "Wrong route", requestId: "wrong-route" }), { status: 400 });
    assert.equal((await service.workspace(owner)).accounts.length, 1);
  } finally { service.close(); }
});

test("third-party mandate previews and payments enforce recipient, balance, identity and limit checks", async () => {
  const { chain, service, owner, agentId } = await fixture();
  try {
    const opened = await openWithMandate(service, owner, mandateOpening());
    const seller = { account: await sellerAccount(service) };
    const input = { agentId, mandateId: opened.mandateId, sellerAddress: seller.account.address, sellerName: "Seller", amount: "1", reference: "Test purchase", requestId: "purchase" };
    const preview = await service.previewMandatePayment(input);
    assert.equal(preview.checks.find(c => c.label.includes("sufficient"))!.passed, false);
    await assert.rejects(service.payWithMandate(input), { status: 409 });
    await service.fund(owner, opened.account.id, { amount: "5", requestId: "fund" });
    assert.ok((await service.previewMandatePayment(input)).checks.every(c => c.passed));
    const paid = await service.payWithMandate(input);
    assert.ok(paid.txHash); assert.equal(paid.destination, seller.account.address);
    assert.equal((await service.payWithMandate(input)).txHash, paid.txHash);
    await assert.rejects(service.payWithMandate({ ...input, mandateId: "someone-else" }), { status: 401 });
    await assert.rejects(service.payWithMandate({ ...input, amount: "2", requestId: "overspend" }), { status: 403 });
    const unverified = StrKey.encodeContract(randomBytes(32));
    await assert.rejects(service.payWithMandate({ ...input, sellerAddress: unverified, requestId: "unverified" }), { status: 403 });
    await assert.rejects(service.payWithMandate({ ...input, sellerAddress: Keypair.random().publicKey(), requestId: "classic" }), { status: 400 });
    chain.verified.delete(seller.account.address!);
    assert.equal((await service.previewMandatePayment(input)).seller.verified, false);
    await assert.rejects(service.payWithMandate({ ...input, requestId: "seller-revoked" }), { status: 403 });
    assert.equal(chain.transfers.filter(t => t.ruleId !== undefined).length, 1);
  } finally { service.close(); }
});

for (const type of ["traditional", "stellar"] as const) {
  test(`${type} payments reject the source as recipient without spending funds or mandate allowance`, async () => {
    const { chain, service, owner, agentId } = await fixture();
    try {
      const source = await service.createAccount(owner, { name: "Source", type, requestId: "source" });
      const seller = await sellerAccount(service);
      await service.fund(owner, source.id, { amount: "10", requestId: "fund" });
      const created = await service.createMandate(owner, { accountId: source.id, name: "Purchasing", recipientType: "agent", recipient: "Buyer", limit: "2", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "mandate" });
      const input = { agentId, mandateId: created.mandateId, sellerAddress: source.address, sellerName: "Source", amount: "0.5", reference: "Purchase", requestId: "self" };
      const identifiers = [source.address];
      for (const identifier of identifiers) {
        const preview = await service.previewMandatePayment({ ...input, sellerAddress: identifier });
        assert.equal(preview.checks.find(check => check.label === "Recipient is different from the source account")!.passed, false);
        await assert.rejects(service.payWithMandate({ ...input, sellerAddress: identifier }), { status: 400, message: /different recipient account/ });
        await assert.rejects(service.pay(owner, { accountId: source.id, destination: identifier, amount: "0.5", reference: "Owner payment", requestId: "self-owner" }), { status: 400, message: /different recipient account/ });
      }
      const before = await service.workspace(owner);
      assert.equal(before.accounts.find(a => a.id === source.id)!.balance, "10");
      assert.equal(await chain.balance(chain.wallet(seller.id), "USD"), 0n);
      assert.equal(before.mandates.find(m => m.reference === created.mandate.reference)!.spent, "0");
      assert.equal(before.activity.filter(e => e.kind === "payment").length, 0);
      assert.equal(chain.transfers.filter(t => t.ruleId !== undefined).length, 0);

      const payment = { ...input, sellerAddress: seller.address, sellerName: "Seller", requestId: "real-payment" };
      assert.ok((await service.previewMandatePayment(payment)).checks.every(check => check.passed));
      const receipt = await service.payWithMandate(payment);
      assert.equal((await service.payWithMandate(payment)).id, receipt.id);
      const after = await service.workspace(owner);
      assert.equal(after.accounts.find(a => a.id === source.id)!.balance, "9.5");
      assert.equal(await chain.balance(chain.wallet(seller.id), "USD"), 5_000_000n);
      assert.equal(after.mandates.find(m => m.reference === created.mandate.reference)!.spent, "0.5");
      assert.equal(after.activity.filter(e => e.kind === "payment").length, 1);
    } finally { service.close(); }
  });
}

test("expired third-party mandate IDs cannot authorize payments", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-14T12:00:00Z") });
  const { service, owner, agentId } = await fixture();
  try {
    const opened = await openWithMandate(service, owner, mandateOpening({ expiresAt: "2026-11-14T12:00:01Z" }));
    t.mock.timers.tick(1001);
    await assert.rejects(service.previewMandatePayment({ agentId, mandateId: opened.mandateId }), { status: 401 });
  } finally { service.close(); }
});

test("/pay accepts a secret mandate ID with registered agent identification and reports paid, declined or pending", async t => {
  const { chain, service, owner, token, agentId } = await fixture();
  const server = createPaymentApp(service).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); });
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/api`;
  const send = (path: string, input: unknown, headers = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input) });
  const opened = await openWithMandate(service, owner, mandateOpening());
  const seller = { account: await sellerAccount(service) };
  const input = { agentId, mandateId: opened.mandateId, sellerAddress: seller.account.address, sellerName: "Seller", amount: "1", reference: "Public payment", requestId: "public-pay" };
  const auth = {};
  const cookieOnly = await send("/pay", input, { cookie: `mandate_session=${token}` });
  assert.equal((await cookieOnly.json() as { status: string }).status, "declined");
  const insufficient = await send("/pay", input, auth);
  assert.match((await insufficient.json() as { reason: string }).reason, /Insufficient/);
  await service.fund(owner, opened.account.id, { amount: "5", requestId: "fund" });
  assert.equal((await send("/pay/preview", input, auth)).status, 200);
  const response = await send("/pay", input, auth);
  const paid = await response.json() as { status: string; payment: { txHash: string } };
  assert.equal(paid.status, "paid"); assert.ok(paid.payment.txHash);
  const retry = await send("/pay", input, auth);
  assert.equal((await retry.json() as { payment: { txHash: string } }).payment.txHash, paid.payment.txHash);
  const wrong = await send("/pay", { ...input, mandateId: "wrong" }, auth);
  assert.equal((await wrong.json() as { status: string }).status, "declined");
  chain.pending = true;
  const pending = await send("/pay", { ...input, requestId: "pending" }, auth);
  assert.equal(pending.status, 202);
  const awaiting = await pending.json() as { status: string; txHash: string };
  assert.equal(awaiting.status, "pending"); assert.equal(awaiting.txHash, "ab".repeat(32));
  chain.pending = false;
  await service.revoke(owner, opened.mandate.reference);
  const revoked = await send("/pay", { ...input, requestId: "revoked" }, auth);
  assert.equal((await revoked.json() as { status: string }).status, "declined");
});

test("signup provisions one verified main account with a private Classic wallet", async () => {
  const { chain, service, owner, agentId } = await fixture();
  try {
    assert.equal(chain.wallets.size, 2, "Signup provisions both wallets before returning");
    const view = await service.workspace(owner);
    const account = view.accounts[0]!;
    assert.equal(view.accounts.length, 1);
    assert.equal(account.name, "Main account");
    assert.ok(account.verified && account.creationTxHash && account.verificationTxHash);
    assert.equal(account.currency, "USD");
    assert.equal(account.balance, "0");
    assert.ok(StrKey.isValidContract(account.address!));
    assert.equal(chain.wallets.size, 2);
    assert.equal(chain.transfers.length, 0);
    assert.equal(JSON.stringify(view).includes(chain.wallet(chain.owners.get(account.id)!).address), false);
  } finally { service.close(); }
});

test("mandates default to the main account and share its balance without provisioning wallets", async () => {
  const { chain, service, owner, agentId } = await fixture();
  try {
    const account = (await service.workspace(owner)).accounts[0]!;
    await service.fund(owner, account.id, { amount: "20", requestId: "fund" });
    const input = { name: "Purchasing", recipientType: "agent", recipient: "Buyer", limit: "5", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "first" };
    const first = await service.createMandate(owner, input);
    const second = await service.createMandate(owner, { ...input, requestId: "second" });
    assert.equal(first.mandate.accountId, account.id);
    assert.equal(second.mandate.accountId, account.id);
    assert.notEqual(first.mandate.reference, second.mandate.reference);
    assert.equal((await service.createMandate(owner, input)).mandateId, first.mandateId);
    assert.equal((await service.workspace(owner)).accounts[0]!.balance, "20");
    assert.equal(chain.wallets.size, 2);
  } finally { service.close(); }
});

test("a preexisting login without accounts receives one main account on sign-in", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mandate-login-migration-"));
  const path = join(directory, "workspace.sqlite");
  const store = new WorkspaceStore(path);
  const chain = new TestChain();
  const service = new StellarPaymentService(path, chain);
  try {
    await store.register({ name: "Existing owner", email: "existing@example.com", password: "a secure existing password" });
    const input = { email: "existing@example.com", password: "a secure existing password" };
    const [first, second] = await Promise.all([service.login(input), service.login(input)]);
    assert.equal(first.customer.id, second.customer.id);
    assert.equal(store.read().accounts.length, 1);
    assert.equal(store.read().stellarPairs.length, 1);
    assert.equal(chain.wallets.size, 2);
    assert.equal((await service.workspace(service.authenticate(first.token))).accounts.length, 1);
  } finally { service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("existing users adopt a stable main account while retaining historical accounts, funds and mandates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mandate-main-migration-"));
  const path = join(directory, "workspace.sqlite");
  const result = await fixture(path);
  const { chain, owner, agentId } = result;
  let service = result.service;
  const store = new WorkspaceStore(path);
  try {
    const first = (await service.workspace(owner)).accounts[0]!;
    const historical = await sellerAccount(service);
    // Represent an old workspace that had multiple accounts and no main identity.
    store.update(state => {
      delete state.customers.find(c => c.id === owner.id)!.mainAccountId;
      state.accounts.find(a => a.id === historical.id)!.ownerId = owner.id;
    });
    await service.fund(owner, historical.id, { amount: "12", requestId: "legacy-funding" });
    const grant = await service.createMandate(owner, { accountId: historical.id, name: "Legacy access", recipientType: "agent", recipient: "Buyer", limit: "2", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "legacy-grant" });
    assert.equal(store.read().customers.find(c => c.id === owner.id)!.mainAccountId, first.id);
    store.update(state => { state.accounts.reverse(); });
    service.close(); service = new StellarPaymentService(path, chain);
    const view = await service.workspace(owner);
    assert.equal(view.accounts[0]!.id, first.id);
    assert.equal(view.accounts.length, 2);
    assert.equal(view.accounts.find(a => a.id === historical.id)!.balance, "12");
    assert.ok(view.mandates.some(m => m.reference === grant.mandate.reference));
    assert.equal(view.activity[0]!.accountId, historical.id);
    assert.equal(chain.wallets.size, 4);
  } finally { store.close(); service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("traditional payments transfer testnet USD, preserve funds, reject unverified recipients and process retries once", async () => {
  const { chain, service, owner, agentId } = await fixture();
  try {
    const source = (await service.openAccount(owner, { name: "Bank source", type: "traditional", requestId: "source" })).account;
    const seller = await sellerAccount(service);
    await service.fund(owner, source.id, { amount: "100", requestId: "fund-bank" });
    await service.fund(owner, source.id, { amount: "100", requestId: "fund-bank" });
    const input = { accountId: source.id, destination: seller.address, amount: "12.50", reference: "Invoice", requestId: "bank-payment" };
    const paid = await service.pay(owner, input);
    assert.equal(paid.settlement, "stellar-testnet"); assert.ok(paid.txHash); assert.equal(paid.currency, "USD");
    assert.equal((await service.pay(owner, input)).id, paid.id);
    await assert.rejects(service.pay(owner, { ...input, amount: "15" }), { status: 409 });
    await assert.rejects(service.pay(owner, { ...input, destination: StrKey.encodeContract(randomBytes(32)), requestId: "wrong-rail" }), { status: 403 });
    await assert.rejects(service.fund(owner, source.id, { amount: "0.001", requestId: "fractional-cent" }), { status: 400 });
    await assert.rejects(service.pay(owner, { ...input, amount: "100", requestId: "over-balance" }), { status: 409 });
    const view = await service.workspace(owner);
    assert.equal(view.accounts.find(a => a.id === source.id)!.balance, "87.5");
    assert.equal(await chain.balance(chain.wallet(seller.id), "USD"), 125_000_000n);
    assert.equal("parent" in view, false); assert.equal(chain.transfers.length, 2);
    await service.fund(owner, source.id, { amount: "1", requestId: "top-up" });
    await service.fund(owner, source.id, { amount: "1", requestId: "top-up" });
    assert.equal((await service.workspace(owner)).accounts.find(a => a.id === source.id)!.balance, "88.5");
  } finally { service.close(); }
});

test("traditional mandates install on-chain USD rules and can pay Stellar Smart Accounts", async () => {
  const { chain, service, owner, agentId } = await fixture();
  try {
    const source = (await service.openAccount(owner, { name: "Source", type: "traditional", requestId: "source" })).account;
    const seller = await sellerAccount(service);
    await service.fund(owner, source.id, { amount: "50", requestId: "fund" });
    const created = await service.createMandate(owner, { accountId: source.id, name: "Team allowance", recipientType: "agent", recipient: "External person", limit: "10", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "bank-mandate" });
    assert.equal("rail" in created.mandate, false); assert.equal(created.mandate.enforcement, "on-chain"); assert.equal(created.mandate.currency, "USD");
    assert.ok(created.mandate.ruleId); assert.equal(created.mandate.accountId, source.id);
    const input = { agentId, mandateId: created.mandateId, sellerAddress: seller.address, sellerName: "Seller", amount: "6", reference: "Travel", requestId: "purchase" };
    assert.ok((await service.previewMandatePayment(input)).checks.every(c => c.passed));
    const paid = await service.payWithMandate(input);
    assert.equal(paid.settlement, "stellar-testnet"); assert.equal(paid.mandateReference, created.mandate.reference);
    await assert.rejects(service.payWithMandate({ ...input, amount: "5", requestId: "over-limit" }), { status: 403 });
    const view = await service.workspace(owner);
    assert.equal(view.accounts.length, 1); assert.equal(view.mandates.find(m => m.reference === created.mandate.reference)!.spent, "6");
    assert.equal(chain.transfers.length, 2); assert.equal(chain.rules.size, 3);
    await service.revoke(owner, created.mandate.reference);
    await assert.rejects(service.previewMandatePayment({ agentId, mandateId: created.mandateId }), { status: 401 });
  } finally { service.close(); }
});

test("traditional account funding and credentials remain isolated across customers", async () => {
  const { service, owner, agentId } = await fixture();
  try {
    const source = (await service.openAccount(owner, { name: "Private source", type: "traditional", requestId: "source" })).account;
    const other = await service.register({ name: "Other owner", email: "bank-other@example.com", password: "long banking password" });
    const actor = service.authenticate(other.token);
    const seller = (await service.openAccount(actor, { name: "Other recipient", type: "traditional", requestId: "seller" })).account;
    await assert.rejects(service.fund(actor, source.id, { amount: "10", requestId: "intrusion" }), { status: 404 });
    await assert.rejects(service.pay(actor, { accountId: source.id, destination: seller.address, amount: "1", reference: "Intrusion", requestId: "intrusion" }), { status: 403 });
    await service.fund(owner, source.id, { amount: "20", requestId: "fund" });
    await service.pay(owner, { accountId: source.id, destination: seller.address, amount: "5", reference: "Cross-owner receipt", requestId: "payment" });
    const otherView = await service.workspace(actor);
    assert.equal(otherView.accounts.length, 1); assert.equal(otherView.accounts[0]!.balance, "5");
    assert.equal(otherView.accounts.some(a => a.id === source.id), false);
  } finally { service.close(); }
});

test("/pay settles a traditional mandate on chain without an owner session or payment method", async t => {
  const { chain, service, owner, token, agentId } = await fixture();
  const server = createPaymentApp(service).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); });
  const port = (server.address() as { port: number }).port;
  const send = (path: string, body: unknown, headers = {}) => fetch(`http://127.0.0.1:${port}/api${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const ownerHeaders = { cookie: `mandate_session=${token}` };
  const source = (await service.workspace(owner)).accounts[0]!;
  const seller = await sellerAccount(service);
  await service.fund(owner, source.id, { amount: "100", requestId: "fund" });
  const mandateResponse = await send("/mandates", { accountId: source.id, name: "Buyer", recipientType: "agent", recipient: "Third party", limit: "10", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "mandate" }, ownerHeaders);
  assert.equal(mandateResponse.status, 201);
  const created = await mandateResponse.json() as { mandate: { reference: string }; mandateId: string };
  const input = { agentId, mandateId: created.mandateId, sellerAddress: seller.address, sellerName: "Bank seller", amount: "5", reference: "Demo invoice", requestId: "public-bank" };
  const headers = {};
  const preview = await send("/pay/preview", input, headers);
  assert.equal(preview.status, 200); assert.equal((await preview.json() as { currency: string }).currency, "USD");
  const paid = await (await send("/pay", input, headers)).json() as { status: string; payment: { settlement: string; txHash?: string } };
  assert.equal(paid.status, "paid"); assert.equal(paid.payment.settlement, "stellar-testnet"); assert.ok(paid.payment.txHash);
  const refused = await send("/pay", { ...input, amount: "6", requestId: "over-limit" }, headers);
  assert.equal((await refused.json() as { status: string }).status, "declined");
  assert.equal(chain.transfers.length, 2);
});


test("login and legacy opening requests reuse the main account without creating more wallets", async () => {
  const { chain, service, owner, agentId } = await fixture();
  try {
    const first = (await service.workspace(owner)).accounts[0]!;
    const second = (await service.openAccount(owner, { name: "Second", type: "traditional", requestId: "second" })).account;
    assert.equal(second.id, first.id);
    const login = await service.login({ email: "owner@example.com", password: "long chain password" });
    const views = await Promise.all([service.workspace(owner), service.workspace(service.authenticate(login.token))]);
    assert.ok(views.every(view => view.accounts.length === 1 && view.accounts[0]!.id === first.id));
    assert.equal(chain.wallets.size, 2);
  } finally { service.close(); }
});

test("Add funds deposits into the mapped wallet then automatically forwards exactly once", async () => {
  const { chain, service, owner, agentId } = await fixture();
  try {
    const account = (await service.openAccount(owner, { name: "Stellar", type: "stellar", requestId: "stellar" })).account;
    const second = await sellerAccount(service);
    const internal = chain.wallet(chain.owners.get(account.id)!);
    const original = await chain.balance(internal);
    const entry = await service.fund(owner, account.id, { amount: "5", requestId: "fund" });
    assert.equal(chain.deposits[0]!.destination, internal.address);
    assert.equal(chain.transfers[0]!.source, internal.address);
    assert.equal(chain.transfers[0]!.destination, account.address);
    assert.equal(await chain.balance(internal), original);
    assert.equal(await chain.balance(chain.wallet(account.id), "USD"), 50_000_000n);
    assert.equal(await chain.balance(chain.wallet(second.id), "USD"), 0n);
    assert.equal((await service.fund(owner, account.id, { amount: "5", requestId: "fund" })).id, entry.id);
    assert.equal(chain.deposits.length, 1); assert.equal(chain.transfers.length, 1);
    await assert.rejects(service.fund(owner, account.id, { amount: "6", requestId: "fund" }), { status: 409 });
    await assert.rejects(service.fund(owner, internal.id, { amount: "1", requestId: "internal" }), { status: 404 });
    await assert.rejects(service.fund(owner, account.id, { amount: "1", sourceAccountId: internal.id, requestId: "override" }), { status: 400 });
    const view = await service.workspace(owner);
    assert.equal(view.activity.length, 1); assert.equal(view.activity[0]!.accountId, account.id);
    assert.equal(JSON.stringify(view).includes(internal.address), false);
  } finally { service.close(); }
});

test("funding retries survive a service restart without repeating the deposit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mandate-funding-recovery-"));
  const path = join(directory, "workspace.sqlite");
  const fixtureResult = await fixture(path);
  const { chain, owner, agentId } = fixtureResult;
  let service = fixtureResult.service;
  try {
    const account = (await service.openAccount(owner, { name: "Stellar", type: "stellar", requestId: "stellar" })).account;
    const input = { amount: "5", requestId: "fund" };
    chain.failFunding = true;
    await assert.rejects(service.fund(owner, account.id, input));
    assert.equal(chain.deposits.length, 1);
    await assert.rejects(service.fund(owner, account.id, { ...input, amount: "6" }), { status: 409 });
    assert.equal(await chain.balance(chain.wallet(account.id), "USD"), 0n);
    assert.equal((await service.workspace(owner)).activity.length, 0);
    service.close(); service = new StellarPaymentService(path, chain);
    chain.failFunding = false;
    await service.fund(owner, account.id, input);
    assert.equal(chain.deposits.length, 1);
    assert.equal(chain.transfers.length, 1);
    assert.equal(await chain.balance(chain.wallet(account.id), "USD"), 50_000_000n);
  } finally { service.close(); rmSync(directory, { recursive: true, force: true }); }
});


test("HTTP sessions protect management routes and public payments require the mandate ID and registered agent identification", async t => {
  const { service, agentId } = await fixture();
  const server = createPaymentApp(service).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const send = (path: string, body: unknown, headers = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await fetch(base + "/workspace")).status, 401);
  const registered = await send("/auth/register", { name: "HTTP user", email: "http@example.com", password: "a secure HTTP password" });
  assert.equal(registered.status, 201);
  const cookieHeader = registered.headers.get("set-cookie")!;
  assert.match(cookieHeader, /HttpOnly/i); assert.match(cookieHeader, /SameSite=Strict/i);
  const session = { cookie: cookieHeader.split(";")[0]! };
  const view = await fetch(base + "/workspace", { headers: session });
  const source = (await view.json() as { accounts: { id: string; address: string }[] }).accounts[0]!;
  const seller = await sellerAccount(service);
  const identityResponse = await send("/agents", { name: "HTTP Buyer", requestId: "http-buyer" }, session);
  assert.equal(identityResponse.status, 201);
  const identity = await identityResponse.json() as { id: string };
  assert.equal((await send(`/accounts/${source.id}/funding`, { amount: "10", requestId: "fund" }, { ...session, origin: "https://other.example" })).status, 403);
  assert.equal((await send(`/accounts/${source.id}/funding`, { amount: "10", requestId: "fund" }, session)).status, 201);
  const grant = await send("/mandates", { accountId: source.id, name: "HTTP agent", recipientType: "agent", recipient: "api-agent", limit: "3", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "grant" }, session);
  assert.equal(grant.status, 201);
  const result = await grant.json() as { mandateId: string; mandate: { reference: string } };
  const payment = { agentId: identity.id, mandateId: result.mandateId, sellerAddress: seller.address, sellerName: "Seller", amount: "2", reference: "Supplies", requestId: "purchase" };
  const first = await send("/pay", payment);
  assert.equal(first.status, 200);
  const receipt = await first.json() as { status: string; payment: { id: string } };
  assert.equal(receipt.status, "paid");
  const retry = await (await send("/pay", payment)).json() as { payment: { id: string } };
  assert.equal(retry.payment.id, receipt.payment.id);
  const denied = await (await send("/pay", { ...payment, requestId: "over-limit" })).json() as { status: string };
  assert.equal(denied.status, "declined");
  assert.equal((await send("/payments", { accountId: seller.id, mandateReference: result.mandate.reference, destination: source.address, amount: "1", reference: "Wrong source", requestId: "wrong-account" }, session)).status, 403);
  assert.equal((await fetch(base + `/mandates/${result.mandate.reference}`, { method: "DELETE", headers: session })).status, 204);
  const revoked = await (await send("/pay", payment)).json() as { status: string };
  assert.equal(revoked.status, "declined");
  assert.equal((await send("/auth/logout", {}, session)).status, 204);
  assert.equal((await fetch(base + "/workspace", { headers: session })).status, 401);
  assert.equal((await send("/auth/login", { email: "http@example.com", password: "a secure HTTP password" })).status, 200);
});

test("person mandates isolate shared access and enforce on-chain windows, expiry and revocation", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-14T12:00:00Z") });
  const { service, owner, agentId } = await fixture();
  try {
    const registered = await service.register({ name: "Holder", email: "holder@example.com", password: "a secure holder password" });
    const holder = service.authenticate(registered.token);
    const source = (await service.openAccount(owner, { name: "Source", type: "traditional", requestId: "source" })).account;
    const seller = await sellerAccount(service);
    await service.fund(owner, source.id, { amount: "50", requestId: "fund" });
    const created = await service.createMandate(owner, { accountId: source.id, name: "Allowance", recipientType: "person", recipient: "holder@example.com", limit: "10", period: "day", expiresAt: "2026-11-17T12:00:00Z", requestId: "grant" });
    const shared = await service.workspace(holder);
    assert.equal(shared.accounts.length, 1); assert.equal(shared.shared.length, 1);
    const payment = { agentId, accountId: source.id, mandateReference: created.mandate.reference, destination: seller.address, amount: "10", reference: "Supplies", requestId: "first" };
    await service.pay(holder, payment);
    await assert.rejects(service.pay(holder, { ...payment, requestId: "over-limit" }), { status: 403 });
    await assert.rejects(service.pay(holder, { ...payment, accountId: seller.id, requestId: "other-account" }), { status: 403 });
    await assert.rejects(service.revoke(holder, created.mandate.reference), { status: 404 });
    t.mock.timers.tick(86400_000);
    assert.equal((await service.workspace(holder)).shared[0]!.mandate.spent, "0");
    await service.pay(holder, { ...payment, requestId: "next-period" });
    await service.revoke(owner, created.mandate.reference);
    await assert.rejects(service.pay(holder, { ...payment, requestId: "revoked" }), { status: 403 });
    const expiring = await service.createMandate(owner, { accountId: source.id, name: "Expires", recipientType: "person", recipient: "holder@example.com", limit: "10", period: "day", expiresAt: "2026-11-16T12:00:00Z", requestId: "expiring" });
    t.mock.timers.tick(86400_000);
    await assert.rejects(service.pay(holder, { ...payment, mandateReference: expiring.mandate.reference, requestId: "expired" }), { status: 403 });
    assert.equal((await service.workspace(holder)).shared.find(s => s.mandate.reference === expiring.mandate.reference)!.mandate.status, "expired");
  } finally { service.close(); }
});

test("secret mandate IDs are stable on retries, owner-revealable, and absent from previews and receipts", async t => {
  const { service, owner, token, agentId } = await fixture();
  const server = createPaymentApp(service).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const send = (path: string, body: unknown, headers = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const source = (await service.openAccount(owner, { name: "Source", type: "traditional", requestId: "source" })).account;
  const seller = await sellerAccount(service);
  await service.fund(owner, source.id, { amount: "20", requestId: "fund" });
  const details = { accountId: source.id, name: "Purchasing", recipientType: "agent", recipient: "Buyer", limit: "10", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "mandate" };
  const created = await service.createMandate(owner, details);
  assert.match(created.mandateId, /^mnd_[A-Za-z0-9_-]{43}$/);
  assert.equal("token" in created, false);
  assert.notEqual(created.mandate.reference, created.mandateId);
  assert.equal((await service.createMandate(owner, details)).mandateId, created.mandateId);
  const second = await service.createMandate(owner, { ...details, requestId: "second" });
  assert.notEqual(second.mandateId, created.mandateId);
  const ownerHeaders = { cookie: `mandate_session=${token}` };
  const path = `/mandates/${created.mandate.reference}/reveal`;
  assert.equal((await send(path, {})).status, 401);
  const other = await service.register({ name: "Other", email: "reveal-other@example.com", password: "another long password" });
  assert.equal((await send(path, {}, { cookie: `mandate_session=${other.token}` })).status, 404);
  const reveal = await send(path, {}, ownerHeaders);
  assert.equal(reveal.status, 200); assert.equal(reveal.headers.get("cache-control"), "no-store");
  assert.equal((await reveal.json() as { mandateId: string }).mandateId, created.mandateId);
  const payment = { agentId, mandateId: created.mandateId, sellerAddress: seller.address, sellerName: "Seller", amount: "2", reference: "Invoice", requestId: "purchase" };
  const publicRef = await send("/pay", { ...payment, mandateId: created.mandate.reference }, { ...ownerHeaders, authorization: `Bearer ${created.mandateId}` });
  assert.equal((await publicRef.json() as { status: string }).status, "declined");
  const missing = await send("/pay", { ...payment, mandateId: undefined }, ownerHeaders);
  assert.equal((await missing.json() as { status: string }).status, "declined");
  const preview = await service.previewMandatePayment(payment);
  const receipt = await service.payWithMandate(payment);
  const view = await service.workspace(owner);
  for (const response of [preview, receipt, view]) {
    const serialized = JSON.stringify(response);
    assert.equal(serialized.includes(created.mandateId), false);
    assert.equal(serialized.includes("mandateIdHash"), false);
  }
  assert.equal(receipt.mandateReference, created.mandate.reference);
  assert.equal("mandateId" in receipt, false);
  await service.revoke(owner, created.mandate.reference);
  assert.equal(service.revealMandate(owner, created.mandate.reference).mandateId, created.mandateId);
  await assert.rejects(service.payWithMandate({ ...payment, requestId: "revoked" }), { status: 401 });
});

test("stored mandates preserve signing rules and secret IDs through normalization and restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mandate-secret-id-"));
  const path = join(directory, "workspace.sqlite");
  const result = await fixture(path);
  const { chain, owner, agentId } = result;
  let service = result.service;
  try {
    const account = (await service.openAccount(owner, { name: "Source", type: "traditional", requestId: "source" })).account;
    const details = { accountId: account.id, name: "Purchasing", recipientType: "agent", recipient: "Buyer", limit: "10", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "mandate" };
    const created = await service.createMandate(owner, details);
    service.close();
    const { WorkspaceStore } = await import("./store.ts");
    const store = new WorkspaceStore(path);
    store.update(state => {
      const saved = state.mandates.find(m => m.id === created.mandate.reference)!;
      Object.assign(saved, { tokenHash: saved.mandateIdHash });
      delete saved.mandateIdHash;
    });
    store.close();
    service = new StellarPaymentService(path, chain);
    assert.equal(service.revealMandate(owner, created.mandate.reference).mandateId, created.mandateId);
    assert.equal((await service.createMandate(owner, details)).mandateId, created.mandateId);
    assert.equal((await service.workspace(owner)).mandates.length, 2);
    assert.equal(readFileSync(path).includes(Buffer.from(created.mandateId)), false);
  } finally { service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Add funds directly confirms the entered demo USD amount and processes retries once", async t => {
  const { chain, service, owner, token, agentId } = await fixture();
  const source = (await service.openAccount(owner, { name: "Demo USD", type: "traditional", requestId: "source" })).account;
  const server = createPaymentApp(service).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => { server.close(); service.close(); });
  const port = (server.address() as { port: number }).port;
  const send = () => fetch(`http://127.0.0.1:${port}/api/accounts/${source.id}/funding`, { method: "POST", headers: { "content-type": "application/json", cookie: `mandate_session=${token}` }, body: JSON.stringify({ amount: "12.34", requestId: "demo-funding" }) });
  const completed = await send();
  assert.equal(completed.status, 201);
  const receipt = await completed.json() as { id: string; amount: string; source: string };
  assert.equal(receipt.amount, "12.34");
  assert.equal(receipt.source, "Demo USD deposit");
  assert.equal((await (await send()).json() as { id: string }).id, receipt.id);
  assert.equal(chain.deposits.length, 1);
  assert.equal(chain.deposits[0]!.amount, 123_400_000n);
  assert.equal(chain.transfers.length, 1);
  const view = await service.workspace(owner);
  assert.equal(view.accounts[0]!.balance, "12.34");
  assert.equal(view.activity.length, 1);
});

for (const stage of ["deposit", "forward"] as const) {
  test(`direct USD funding recovers after a ${stage} failure and restart without a fiat ledger or duplicate tokens`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "mandate-anchor-recovery-"));
    const path = join(directory, "workspace.sqlite");
    const fixtureResult = await fixture(path);
    const { chain, owner, agentId } = fixtureResult;
    let service = fixtureResult.service;
    const store = new WorkspaceStore(path);
    try {
      const source = (await service.openAccount(owner, { name: "USD", type: "traditional", requestId: "source" })).account;
      const input = { amount: "12.34", requestId: "deposit" };
      chain.fail = stage === "deposit"; chain.failFunding = stage === "forward";
      await assert.rejects(service.fund(owner, source.id, input));
      const pending = store.read();
      assert.equal("fiatAccounts" in pending, false);
      assert.equal("anchorDeposits" in pending, false);
      const internal = chain.wallet(chain.owners.get(source.id)!);
      assert.equal(await chain.balance(internal, "USD"), stage === "deposit" ? 0n : 123_400_000n);
      assert.equal((await service.workspace(owner)).activity.length, 0);
      await assert.rejects(service.fund(owner, source.id, { ...input, amount: "13" }), { status: 409 });
      service.close(); service = new StellarPaymentService(path, chain);
      chain.fail = false; chain.failFunding = false;
      const paid = await service.fund(owner, source.id, input);
      assert.equal((await service.fund(owner, source.id, input)).txHash, paid.txHash);
      assert.equal(chain.deposits.length, 1); assert.equal(chain.transfers.length, 1);
      assert.equal(chain.deposits[0]!.currency, "USD");
      assert.equal(chain.deposits[0]!.amount, 123_400_000n);
      assert.equal(chain.transfers[0]!.currency, "USD");
      assert.equal(await chain.balance(chain.wallet(source.id), "USD"), 123_400_000n);
      assert.equal(await chain.balance(chain.wallet(source.id), "XLM"), 0n);
      const journal = store.read();
      assert.equal("fiatAccounts" in journal, false);
      assert.equal("anchorDeposits" in journal, false);
      assert.equal(await chain.balance(internal, "USD"), 0n);
      const view = await service.workspace(owner);
      assert.equal(view.accounts.length, 1); assert.equal(view.activity.length, 1);
      assert.equal(JSON.stringify(view).includes(chain.wallet(chain.owners.get(source.id)!).address), false);
      assert.equal("fiatAccounts" in view, false); assert.equal("anchorDeposits" in view, false);
    } finally { store.close(); service.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

test("both account options default to USD mandates and expose only USD balances", async () => {
  const { chain, service, owner, agentId } = await fixture();
  try {
    const bank = await service.createAccount(owner, { name: "Bank", type: "traditional", requestId: "bank" });
    const stellar = await sellerAccount(service);
    const stellarOwner = { kind: "customer" as const, id: stellar.ownerId };
    const stellarAgent = await service.createAgent(stellarOwner, { name: "Buyer", requestId: "buyer" });
    assert.equal(bank.currency, "USD"); assert.equal(stellar.currency, "USD");
    await service.fund(owner, bank.id, { amount: "10", requestId: "bank-funding" });
    await service.fund(stellarOwner, stellar.id, { amount: "5", requestId: "stellar-funding" });
    chain.balances.set(stellar.address!, 900_000_000n);
    await service.pay(owner, { accountId: bank.id, destination: stellar.address, amount: "2", reference: "USD", requestId: "usd" });
    const view = await service.workspace(owner);
    assert.ok(view.accounts.every(account => account.currency === "USD" && !("balances" in account)));
    assert.equal((await service.workspace(stellarOwner)).accounts[0]!.balance, "7");
    assert.equal(view.network!.currency, "USD");
    const details = { accountId: stellar.id, name: "Dollars", recipientType: "agent", recipient: "Buyer", limit: "1", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "usd-grant" };
    const created = await service.createMandate(stellarOwner, details);
    assert.equal(created.mandate.currency, "USD");
    assert.equal(chain.rules.get(created.mandate.ruleId!)!.currency, "USD");
    await assert.rejects(service.createMandate(stellarOwner, { ...details, currency: "XLM", requestId: "xlm-grant" }), { status: 400 });
    const input = { agentId: stellarAgent.id, mandateId: created.mandateId, sellerAddress: bank.address, amount: "0.5", reference: "Return dollars", requestId: "return" };
    assert.equal((await service.previewMandatePayment(input)).currency, "USD");
    assert.equal((await service.payWithMandate({ ...input, accountId: bank.id, currency: "XLM" })).currency, "USD");
    assert.equal(chain.transfers.at(-1)!.source, stellar.address);
    assert.equal(chain.transfers.at(-1)!.currency, "USD");
    await assert.rejects(service.pay(stellarOwner, { accountId: stellar.id, currency: "XLM", destination: bank.address, amount: "0.5", reference: "Wrong asset", requestId: "wrong-currency" }), { status: 400 });
    assert.equal(await chain.balance(chain.wallet(stellar.id), "XLM"), 900_000_000n);
    assert.equal((await service.workspace(stellarOwner)).accounts[0]!.balance, "6.5");
  } finally { service.close(); }
});

test("legacy demo accounts upgrade their balance exactly once after interrupted forwarding and retire service-only mandates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mandate-legacy-upgrade-"));
  const path = join(directory, "workspace.sqlite");
  const fixtureResult = await fixture(path);
  const { chain, owner, agentId } = fixtureResult;
  let service = fixtureResult.service;
  const store = new WorkspaceStore(path);
  try {
    store.update(state => {
      state.accounts = []; state.stellarPairs = [];
      delete state.customers[0]!.mainAccountId;
      state.accounts.push({ id: "legacy-bank", ownerId: owner.id, name: "Old demo", type: "traditional", rail: "traditional", balance: "25.50", currency: "USD", address: "BANK_DEMO_OLD", createdAt: new Date().toISOString() });
      state.mandates.push({ id: "legacy-mandate", accountId: "legacy-bank", name: "Old grant", recipientType: "agent", recipient: "Buyer", limit: "10", spent: "0", period: "day", status: "active", expiresAt: new Date(Date.now() + 86400_000).toISOString(), createdAt: new Date().toISOString(), enforcement: "service" });
    });
    chain.failFunding = true;
    await assert.rejects(service.workspace(owner));
    assert.equal(store.read().mandates.find(m => m.id === "legacy-mandate")!.status, "revoked");
    assert.equal(chain.deposits.length, 1);
    assert.equal(store.read().traditionalUpgrades![0]!.completed, false);
    service.close(); service = new StellarPaymentService(path, chain);
    chain.failFunding = false;
    const view = await service.workspace(owner);
    assert.equal(view.accounts.length, 1);
    assert.ok(StrKey.isValidContract(view.accounts[0]!.address!));
    assert.equal(view.accounts[0]!.balance, "25.5");
    assert.equal(view.mandates.find(m => m.reference === "legacy-mandate")!.status, "revoked");
    assert.equal(chain.deposits.length, 1); assert.equal(chain.transfers.length, 1);
    await service.workspace(owner);
    assert.equal(chain.deposits.length, 1); assert.equal(store.read().traditionalUpgrades![0]!.completed, true);
  } finally { store.close(); service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("legacy Stellar metadata and cached openings expose USD without reinterpreting existing XLM rules", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mandate-usd-default-"));
  const path = join(directory, "workspace.sqlite");
  const { chain, service, owner, agentId } = await fixture(path);
  const store = new WorkspaceStore(path);
  try {
    const account = await service.createAccount(owner, { name: "Existing Stellar", type: "stellar", requestId: "existing" });
    const seller = await sellerAccount(service);
    const details = { accountId: account.id, name: "Legacy", recipientType: "agent", recipient: "Buyer", limit: "2", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "old-mandate" };
    const legacy = await service.createMandate(owner, details);
    store.update(state => {
      state.accounts.find(saved => saved.id === account.id)!.currency = "XLM";
      delete state.mandates.find(saved => saved.id === legacy.mandate.reference)!.currency;
    });
    chain.rules.get(legacy.mandate.ruleId!)!.currency = "XLM";
    chain.balances.set(account.address!, 500_000_000n);
    chain.usdBalances.set(account.address!, 30_000_000n);
    const reopened = await service.createAccount(owner, { name: "Existing Stellar", type: "stellar", requestId: "existing" });
    assert.equal(reopened.currency, "USD"); assert.equal(reopened.balance, "3");
    const view = await service.workspace(owner);
    assert.equal(view.accounts[0]!.currency, "USD"); assert.equal(view.accounts[0]!.balance, "3");
    assert.equal("balances" in view.accounts[0]!, false);
    assert.equal(view.mandates.find(m => m.reference === legacy.mandate.reference)!.currency, "XLM");
    await assert.rejects(service.previewMandatePayment({ agentId, mandateId: legacy.mandateId, sellerAddress: seller.address, amount: "1" }), { status: 400 });
    await service.fund(owner, account.id, { amount: "1", requestId: "new-funding" });
    const usd = await service.createMandate(owner, { ...details, requestId: "new-usd-mandate" });
    assert.equal(usd.mandate.currency, "USD");
    assert.equal((await service.payWithMandate({ agentId, mandateId: usd.mandateId, sellerAddress: seller.address, amount: "0.5", reference: "USD", requestId: "usd-payment" })).currency, "USD");
    assert.equal(await chain.balance(chain.wallet(account.id), "USD"), 35_000_000n);
    assert.equal(await chain.balance(chain.wallet(account.id), "XLM"), 500_000_000n);
  } finally { store.close(); service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("one account can be opened without a type and funded by FIAT or automatic Testnet", async () => {
  const { chain, service, owner, agentId } = await fixture();
  try {
    const input = { name: "Operations", requestId: "unified-opening" };
    const opened = await service.openAccount(owner, input);
    assert.equal((await service.openAccount(owner, input)).account.id, opened.account.id);
    assert.ok(StrKey.isValidContract(opened.account.address!));
    assert.equal(opened.account.balance, "0");
    assert.equal(opened.account.verified, true);
    const fiat = { amount: "12.34", method: "fiat", requestId: "fiat-funding" };
    const testnet = { amount: "5", method: "testnet", requestId: "testnet-funding" };
    const deposit = await service.fund(owner, opened.account.id, fiat);
    const funding = await service.fund(owner, opened.account.id, testnet);
    assert.equal(deposit.source, "Demo USD deposit");
    assert.equal(funding.source, "Stellar testnet funding");
    assert.equal(funding.reference, "Testnet funding");
    assert.equal((await service.fund(owner, opened.account.id, fiat)).id, deposit.id);
    assert.equal((await service.fund(owner, opened.account.id, testnet)).id, funding.id);
    await assert.rejects(service.fund(owner, opened.account.id, { ...fiat, method: "testnet" }), { status: 409 });
    await assert.rejects(service.fund(owner, opened.account.id, { ...testnet, method: "fiat" }), { status: 409 });
    await assert.rejects(service.fund(owner, opened.account.id, { ...fiat, method: "invalid", requestId: "invalid-method" }), { status: 400 });
    assert.equal(chain.deposits.length, 2);
    assert.equal(chain.transfers.length, 2);
    assert.ok(chain.deposits.every(deposit => deposit.currency === "USD"));
    const workspace = await service.workspace(owner);
    assert.equal(workspace.accounts.length, 1);
    assert.equal(workspace.accounts[0]!.balance, "17.34");
    assert.equal(workspace.activity.length, 2);
  } finally { service.close(); }
});

test("seller restrictions are saved without verification and enforced for every mandate payment path", async () => {
  const { chain, service, owner, agentId } = await fixture();
  try {
    const source = await service.createAccount(owner, { name: "Source", requestId: "source" });
    const registered = await service.register({ name: "Seller", email: "seller@example.com", password: "long seller password" });
    const holder = service.authenticate(registered.token);
    const allowed = await service.createAccount(holder, { name: "Allowed", requestId: "allowed" });
    const blocked = await sellerAccount(service);
    assert.ok(Number.isSafeInteger(allowed.sellerId));
    assert.notEqual(allowed.sellerId, blocked.sellerId);
    await service.fund(owner, source.id, { amount: "10", requestId: "fund" });
    const details = { accountId: source.id, name: "Restricted", recipientType: "person", recipient: "seller@example.com", limit: "10", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), sellerIds: [999999, allowed.sellerId!, allowed.sellerId!], requestId: "restricted" };
    const verify = chain.isVerifiedSmartAccount.bind(chain);
    chain.isVerifiedSmartAccount = async () => { throw new Error("Creation must not verify sellers"); };
    const created = await service.createMandate(owner, details);
    chain.isVerifiedSmartAccount = verify;
    assert.deepEqual(created.mandate.sellerIds, [allowed.sellerId, 999999]);
    assert.deepEqual((await service.workspace(holder)).shared[0]!.mandate.sellerIds, created.mandate.sellerIds);
    await assert.rejects(service.createMandate(owner, { ...details, sellerIds: [blocked.sellerId!] }), { status: 409 });

    const input = { agentId, mandateId: created.mandateId, sellerAddress: blocked.address, sellerName: allowed.name, sellerId: allowed.sellerId, amount: "1", reference: "Purchase", requestId: "blocked-public" };
    const preview = await service.previewMandatePayment(input);
    assert.equal(preview.seller.verified, true);
    assert.equal(preview.checks.find(check => check.label.includes("seller ID list"))!.passed, false);
    const before = chain.transfers.length;
    await assert.rejects(service.payWithMandate(input), { status: 403, message: "Seller is not in this mandate's allowed seller ID list" });
    for (const actor of [owner, holder]) {
      await assert.rejects(service.pay(actor, { agentId, accountId: source.id, mandateReference: created.mandate.reference, destination: blocked.address, amount: "1", reference: "Purchase", requestId: `blocked-${actor.id}` }), { status: 403 });
    }
    assert.equal(chain.transfers.length, before);
    assert.equal(await chain.spent(chain.wallet(source.id), created.mandate.ruleId!), 0n);

    chain.verified.delete(allowed.address!);
    const allowedInput = { ...input, sellerAddress: allowed.address, requestId: "allowed" };
    const unverified = await service.previewMandatePayment(allowedInput);
    assert.equal(unverified.checks.find(check => check.label.includes("seller ID list"))!.passed, true);
    assert.equal(unverified.seller.verified, false);
    await assert.rejects(service.payWithMandate(allowedInput), { status: 403, message: "Seller is not a verified smart account" });
    chain.verified.add(allowed.address!);
    const paid = await service.payWithMandate(allowedInput);
    assert.equal(paid.destination, allowed.address);
    assert.equal((await service.payWithMandate(allowedInput)).id, paid.id);
    assert.equal(chain.transfers.length, before + 1);
    assert.equal((await service.workspace(owner)).mandates.find(m => m.reference === created.mandate.reference)!.spent, "1");
  } finally { service.close(); }
});

test("a seller ID may be listed before its account exists and remains stable on account retries", async () => {
  const { service, owner, agentId } = await fixture();
  try {
    const source = await service.createAccount(owner, { name: "Source", requestId: "source" });
    const futureId = source.sellerId! + 1;
    const created = await service.createMandate(owner, { accountId: source.id, name: "Future seller", recipientType: "agent", recipient: "Buyer", limit: "1", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), sellerIds: [futureId], requestId: "future" });
    const sellerInput = { name: "Future seller", requestId: "seller" };
    const seller = await sellerAccount(service);
    const sellerActor = { kind: "customer" as const, id: seller.ownerId };
    assert.equal(seller.sellerId, futureId);
    assert.equal((await service.createAccount(sellerActor, sellerInput)).sellerId, futureId);
    await service.fund(owner, source.id, { amount: "1", requestId: "fund" });
    assert.equal((await service.previewMandatePayment({ agentId, mandateId: created.mandateId, sellerAddress: seller.address, amount: "1" })).checks.every(check => check.passed), true);
    await service.payWithMandate({ agentId, mandateId: created.mandateId, sellerAddress: seller.address, amount: "1", reference: "Future purchase", requestId: "pay" });
  } finally { service.close(); }
});

test("agent registrations persist, stay account-scoped, and publish only after chain confirmation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mandate-agents-"));
  const path = join(directory, "workspace.sqlite");
  const result = await fixture(path);
  const { chain, owner, agentId } = result;
  let service = result.service;
  try {
    const input = { name: "Researcher", requestId: "researcher" };
    chain.fail = true;
    await assert.rejects(service.createAgent(owner, input));
    assert.equal((await service.workspace(owner)).agents.length, 2);
    chain.fail = false;
    const agent = await service.createAgent(owner, input);
    assert.equal((await service.createAgent(owner, input)).id, agent.id);
    await assert.rejects(service.createAgent(owner, { ...input, name: "Changed" }), { status: 409 });
    const other = await service.register({ name: "Other", email: "agent-other@example.com", password: "another secure password" });
    const otherAgents = (await service.workspace(service.authenticate(other.token))).agents;
    assert.equal(otherAgents.length, 1);
    assert.equal(otherAgents[0]!.name, "Chat agent");
    service.close(); service = new StellarPaymentService(path, chain);
    const view = await service.workspace(owner);
    assert.deepEqual(view.agents.map(agent => agent.id), [(await service.defaultChatAgent(owner)).id, agentId, agent.id]);
    assert.ok(view.agents.every(agent => agent.verified && agent.verificationTxHash));
    chain.agents.delete(`${view.accounts[0]!.address}:${agent.id}`);
    assert.equal((await service.workspace(owner)).agents.find(saved => saved.id === agent.id)!.verified, false);
  } finally { service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("payments require a chain-registered account agent and allow every agent on that account", async () => {
  const { chain, service, owner, agentId } = await fixture();
  try {
    const account = (await service.workspace(owner)).accounts[0]!;
    const second = await service.createAgent(owner, { name: "Assistant", requestId: "assistant" });
    const seller = await sellerAccount(service);
    const foreign = await service.createAgent({ kind: "customer", id: seller.ownerId }, { name: "Foreign", requestId: "foreign" });
    await service.fund(owner, account.id, { amount: "10", requestId: "fund" });
    const grant = await service.createMandate(owner, { name: "Purchasing", recipientType: "agent", recipient: "Team", limit: "2", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "grant" });
    const input = { mandateId: grant.mandateId, agentId, sellerAddress: seller.address, sellerName: "Seller", amount: "0.5", reference: "Purchase", requestId: "first" };
    const before = chain.transfers.length;
    for (const invalid of [undefined, "", "unknown", foreign.id]) {
      await assert.rejects(service.previewMandatePayment({ ...input, agentId: invalid }));
      await assert.rejects(service.payWithMandate({ ...input, agentId: invalid }));
    }
    assert.equal(chain.transfers.length, before);
    const preview = await service.previewMandatePayment(input);
    assert.equal(preview.agent.id, agentId);
    const first = await service.payWithMandate(input);
    assert.equal(first.agentId, agentId);
    assert.equal((await service.payWithMandate(input)).id, first.id);
    await assert.rejects(service.payWithMandate({ ...input, agentId: second.id }), { status: 409 });
    const next = await service.payWithMandate({ ...input, agentId: second.id, requestId: "second" });
    assert.equal(next.agentId, second.id);
    chain.agents.delete(`${account.address}:${agentId}`);
    await assert.rejects(service.payWithMandate({ ...input, requestId: "revoked-agent" }), { status: 403 });
    await assert.rejects(service.pay(owner, { accountId: account.id, mandateReference: grant.mandate.reference, destination: seller.address, amount: "0.5", reference: "Bypass", requestId: "bypass" }), { status: 401 });
    assert.equal((await service.workspace(owner)).mandates.find(m => m.reference === grant.mandate.reference)!.spent, "1");
  } finally { service.close(); }
});
