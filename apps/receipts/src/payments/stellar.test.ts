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
  network: PaymentNetwork = { id: "stellar:testnet", name: "Test chain", rpcUrl: "https://rpc.example", horizonUrl: "https://horizon.example", explorerUrl: "https://explorer.example", currency: "XLM", tokenContract: StrKey.encodeContract(randomBytes(32)), smartAccounts: true, verifiedSmartAccounts: true, mandates: true, faucet: true };
  verified = new Set<string>();
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
  async transfer(_id: string, _treasury: ChainWallet, source: ChainWallet, destination: string, units: bigint, mandate?: { id: string; ruleId: number }, currency = "XLM") {
    if (this.transactions.has(_id)) return this.transactions.get(_id)!;
    if (this.fail || (this.failFunding && source.rail === "classic")) throw new Error("Network unavailable");
    if (source.rail === "blockchain") assert.equal(_treasury.id, this.owners.get(source.id), "The linked Classic wallet must sign");
    if (this.pending) throw new ServiceError(503, "Awaiting network confirmation", "ab".repeat(32));
    assert.ok(await this.balance(source, currency) >= units, "Network rejected insufficient funds");
    if (source.rail === "blockchain") assert.ok(await this.isVerifiedSmartAccount(destination), "Contract rejected recipient");
    if (mandate) {
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
  return { chain, service, owner, token: registered.token };
}

test("chain workspace reads external balances and configurable network metadata", async () => {
  const { chain, service, owner } = await fixture();
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

test("failed chain deployment publishes no account and successful creation returns its transaction", async () => {
  const { chain, service, owner } = await fixture();
  try {
    chain.fail = true;
    const input = { name: "Research", type: "stellar", requestId: "research" };
    await assert.rejects(service.createAccount(owner, input));
    assert.equal((await service.workspace(owner)).accounts.length, 0);
    chain.fail = false;
    const created = await service.createAccount(owner, input);
    assert.ok(created.address?.startsWith("C")); assert.ok(created.creationTxHash);
    assert.equal(created.currency, "USD");
    assert.equal((await service.createAccount(owner, input)).id, created.id);
    assert.equal((await service.workspace(owner)).accounts.length, 1);
  } finally { service.close(); }
});

test("funding and payments use network addresses and only journal confirmed receipts", async () => {
  const { chain, service, owner } = await fixture();
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
  const { chain, service, owner } = await fixture();
  try {
    const account = await service.createAccount(owner, { name: "Smart", type: "stellar", requestId: "smart" });
    await service.fund(owner, account.id, { amount: "10", requestId: "fund" });
    const result = await service.createMandate(owner, { accountId: account.id, name: "Agent", recipientType: "agent", recipient: "agent", limit: "2", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "mandate" });
    assert.equal(result.mandate.enforcement, "on-chain");
    const seller = await service.createAccount(owner, { name: "Seller", type: "stellar", requestId: "seller" });
    const paid = await service.payWithMandate({ mandateId: result.mandateId, amount: "1", sellerAddress: seller.address, reference: "Test", requestId: "payment" });
    assert.equal(paid.mandateReference, result.mandate.reference);
    assert.equal(chain.transfers.at(-1)!.ruleId, result.mandate.ruleId);
    const view = await service.workspace(owner); assert.equal(view.mandates[0]!.spent, "1");
    assert.equal(JSON.stringify(view).includes(result.mandateId), false);
    await service.revoke(owner, result.mandate.reference);
    assert.equal(chain.rules.get(result.mandate.ruleId!)!.revoked, true);
    await assert.rejects(service.previewMandatePayment({ mandateId: result.mandateId }), { status: 401 });
  } finally { service.close(); }
});

test("failed on-chain revocation disables service access and stays visibly retryable", async () => {
  const { chain, service, owner } = await fixture();
  try {
    const account = await service.createAccount(owner, { name: "Smart", type: "stellar", requestId: "smart" });
    const grant = await service.createMandate(owner, { accountId: account.id, name: "Agent", recipientType: "agent", recipient: "agent", limit: "1", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "mandate" });
    chain.fail = true;
    await assert.rejects(service.revoke(owner, grant.mandate.reference));
    await assert.rejects(service.previewMandatePayment({ mandateId: grant.mandateId }), { status: 401 });
    assert.equal((await service.workspace(owner)).mandates[0]!.chainRevocationPending, true);
    assert.equal(chain.rules.get(grant.mandate.ruleId!)!.revoked, false);
    chain.fail = false;
    await service.revoke(owner, grant.mandate.reference);
    assert.equal((await service.workspace(owner)).mandates[0]!.chainRevocationPending, false);
    assert.equal(chain.rules.get(grant.mandate.ruleId!)!.revoked, true);
  } finally { service.close(); }
});

test("a chain account and its mandates remain isolated from other customers", async () => {
  const { chain, service, owner } = await fixture();
  try {
    const account = await service.createAccount(owner, { name: "Private", type: "stellar", requestId: "private" });
    const other = await service.register({ name: "Other", email: "other@example.com", password: "other chain password" });
    const actor = service.authenticate(other.token);
    await assert.rejects(service.fund(actor, account.id, { amount: "1", requestId: "fund" }), { status: 404 });
    await assert.rejects(service.pay(actor, { accountId: account.id, amount: "1", destination: Keypair.random().publicKey(), reference: "Unauthorized", requestId: "pay" }), { status: 403 });
    assert.deepEqual((await service.workspace(actor)).accounts, []);
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
  const { chain, service, owner } = await fixture();
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
  const { chain, service, owner } = await fixture();
  try {
    const opened = await openWithMandate(service, owner, mandateOpening());
    const seller = await service.openAccount(owner, { name: "Seller", type: "stellar", requestId: "seller" });
    const input = { mandateId: opened.mandateId, sellerAddress: seller.account.address, sellerName: "Seller", amount: "1", reference: "Test purchase", requestId: "purchase" };
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
    const { chain, service, owner } = await fixture();
    try {
      const source = await service.createAccount(owner, { name: "Source", type, requestId: "source" });
      const seller = await service.createAccount(owner, { name: "Seller", type, requestId: "seller" });
      await service.fund(owner, source.id, { amount: "10", requestId: "fund" });
      const created = await service.createMandate(owner, { accountId: source.id, name: "Purchasing", recipientType: "agent", recipient: "Buyer", limit: "2", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "mandate" });
      const input = { mandateId: created.mandateId, sellerAddress: source.address, sellerName: "Source", amount: "0.5", reference: "Purchase", requestId: "self" };
      const identifiers = [source.address];
      for (const identifier of identifiers) {
        const preview = await service.previewMandatePayment({ ...input, sellerAddress: identifier });
        assert.equal(preview.checks.find(check => check.label === "Recipient is different from the source account")!.passed, false);
        await assert.rejects(service.payWithMandate({ ...input, sellerAddress: identifier }), { status: 400, message: /different recipient account/ });
        await assert.rejects(service.pay(owner, { accountId: source.id, destination: identifier, amount: "0.5", reference: "Owner payment", requestId: "self-owner" }), { status: 400, message: /different recipient account/ });
      }
      const before = await service.workspace(owner);
      assert.equal(before.accounts.find(a => a.id === source.id)!.balance, "10");
      assert.equal(before.accounts.find(a => a.id === seller.id)!.balance, "0");
      assert.equal(before.mandates[0]!.spent, "0");
      assert.equal(before.activity.filter(e => e.kind === "payment").length, 0);
      assert.equal(chain.transfers.filter(t => t.ruleId !== undefined).length, 0);

      const payment = { ...input, sellerAddress: seller.address, sellerName: "Seller", requestId: "real-payment" };
      assert.ok((await service.previewMandatePayment(payment)).checks.every(check => check.passed));
      const receipt = await service.payWithMandate(payment);
      assert.equal((await service.payWithMandate(payment)).id, receipt.id);
      const after = await service.workspace(owner);
      assert.equal(after.accounts.find(a => a.id === source.id)!.balance, "9.5");
      assert.equal(after.accounts.find(a => a.id === seller.id)!.balance, "0.5");
      assert.equal(after.mandates[0]!.spent, "0.5");
      assert.equal(after.activity.filter(e => e.kind === "payment").length, 1);
    } finally { service.close(); }
  });
}

test("expired third-party mandate IDs cannot authorize payments", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-14T12:00:00Z") });
  const { service, owner } = await fixture();
  try {
    const opened = await openWithMandate(service, owner, mandateOpening({ expiresAt: "2026-11-14T12:00:01Z" }));
    t.mock.timers.tick(1001);
    await assert.rejects(service.previewMandatePayment({ mandateId: opened.mandateId }), { status: 401 });
  } finally { service.close(); }
});

test("/pay accepts a secret mandate ID without an owner cookie or separate credential and reports paid, declined or pending", async t => {
  const { chain, service, owner, token } = await fixture();
  const server = createPaymentApp(service).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); });
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/api`;
  const send = (path: string, input: unknown, headers = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input) });
  const opened = await openWithMandate(service, owner, mandateOpening());
  const seller = await service.openAccount(owner, { name: "Seller", type: "stellar", requestId: "seller" });
  const input = { mandateId: opened.mandateId, sellerAddress: seller.account.address, sellerName: "Seller", amount: "1", reference: "Public payment", requestId: "public-pay" };
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

test("traditional accounts expose one verified Smart Account and keep their Classic wallet private", async () => {
  const { chain, service, owner } = await fixture();
  try {
    const wallets = chain.wallets.size;
    const opened = await service.openAccount(owner, { name: "Operating bank account", type: "traditional", requestId: "bank" });
    assert.equal(opened.account.rail, "traditional"); assert.equal(opened.account.type, "traditional");
    assert.equal(opened.account.verified, true); assert.equal(opened.account.verificationSource, "on-chain");
    assert.equal(opened.account.currency, "USD"); assert.ok(StrKey.isValidContract(opened.account.address!));
    assert.equal("bankDetails" in opened.account, false);
    assert.ok(opened.account.creationTxHash); assert.equal("token" in opened, false);
    assert.equal(chain.wallets.size, wallets + 2); assert.equal(chain.transfers.length, 0);
    assert.equal((await service.openAccount(owner, { name: "Operating bank account", type: "traditional", requestId: "bank" })).account.id, opened.account.id);
    const view = await service.workspace(owner);
    assert.equal(view.accounts.find(a => a.id === opened.account.id)!.verified, true); assert.equal(opened.account.balance, "0");
  } finally { service.close(); }
});

test("traditional payments transfer testnet USD, preserve funds, reject unverified recipients and process retries once", async () => {
  const { chain, service, owner } = await fixture();
  try {
    const source = (await service.openAccount(owner, { name: "Bank source", type: "traditional", requestId: "source" })).account;
    const seller = (await service.openAccount(owner, { name: "Bank seller", type: "traditional", requestId: "seller" })).account;
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
    assert.equal(view.accounts.find(a => a.id === seller.id)!.balance, "12.5");
    assert.equal("parent" in view, false); assert.equal(chain.transfers.length, 2);
    await service.fund(owner, source.id, { amount: "1", requestId: "top-up" });
    await service.fund(owner, source.id, { amount: "1", requestId: "top-up" });
    assert.equal((await service.workspace(owner)).accounts.find(a => a.id === source.id)!.balance, "88.5");
  } finally { service.close(); }
});

test("traditional mandates install on-chain USD rules and can pay Stellar Smart Accounts", async () => {
  const { chain, service, owner } = await fixture();
  try {
    const source = (await service.openAccount(owner, { name: "Source", type: "traditional", requestId: "source" })).account;
    const seller = (await service.openAccount(owner, { name: "Seller", type: "stellar", requestId: "seller" })).account;
    await service.fund(owner, source.id, { amount: "50", requestId: "fund" });
    const created = await service.createMandate(owner, { accountId: source.id, name: "Team allowance", recipientType: "agent", recipient: "External person", limit: "10", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "bank-mandate" });
    assert.equal("rail" in created.mandate, false); assert.equal(created.mandate.enforcement, "on-chain"); assert.equal(created.mandate.currency, "USD");
    assert.ok(created.mandate.ruleId); assert.equal(created.mandate.accountId, source.id);
    const input = { mandateId: created.mandateId, sellerAddress: seller.address, sellerName: "Seller", amount: "6", reference: "Travel", requestId: "purchase" };
    assert.ok((await service.previewMandatePayment(input)).checks.every(c => c.passed));
    const paid = await service.payWithMandate(input);
    assert.equal(paid.settlement, "stellar-testnet"); assert.equal(paid.mandateReference, created.mandate.reference);
    await assert.rejects(service.payWithMandate({ ...input, amount: "5", requestId: "over-limit" }), { status: 403 });
    const view = await service.workspace(owner);
    assert.equal(view.accounts.length, 2); assert.equal(view.mandates[0]!.spent, "6");
    assert.equal(chain.transfers.length, 2); assert.equal(chain.rules.size, 1);
    await service.revoke(owner, created.mandate.reference);
    await assert.rejects(service.previewMandatePayment({ mandateId: created.mandateId }), { status: 401 });
  } finally { service.close(); }
});

test("traditional account funding and credentials remain isolated across customers", async () => {
  const { service, owner } = await fixture();
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
  const { chain, service, owner, token } = await fixture();
  const server = createPaymentApp(service).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); });
  const port = (server.address() as { port: number }).port;
  const send = (path: string, body: unknown, headers = {}) => fetch(`http://127.0.0.1:${port}/api${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const ownerHeaders = { cookie: `mandate_session=${token}` };
  const accountResponse = await send("/accounts/open", { name: "Bank source", type: "traditional", requestId: "source" }, ownerHeaders);
  assert.equal(accountResponse.status, 201);
  const { account: source } = await accountResponse.json() as { account: { id: string } };
  const seller = (await service.openAccount(owner, { name: "Bank seller", type: "traditional", requestId: "seller" })).account;
  await service.fund(owner, source.id, { amount: "100", requestId: "fund" });
  const mandateResponse = await send("/mandates", { accountId: source.id, name: "Buyer", recipientType: "agent", recipient: "Third party", limit: "10", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "mandate" }, ownerHeaders);
  assert.equal(mandateResponse.status, 201);
  const created = await mandateResponse.json() as { mandate: { reference: string }; mandateId: string };
  const input = { mandateId: created.mandateId, sellerAddress: seller.address, sellerName: "Bank seller", amount: "5", reference: "Demo invoice", requestId: "public-bank" };
  const headers = {};
  const preview = await send("/pay/preview", input, headers);
  assert.equal(preview.status, 200); assert.equal((await preview.json() as { currency: string }).currency, "USD");
  const paid = await (await send("/pay", input, headers)).json() as { status: string; payment: { settlement: string; txHash?: string } };
  assert.equal(paid.status, "paid"); assert.equal(paid.payment.settlement, "stellar-testnet"); assert.ok(paid.payment.txHash);
  const refused = await send("/pay", { ...input, amount: "6", requestId: "over-limit" }, headers);
  assert.equal((await refused.json() as { status: string }).status, "declined");
  assert.equal(chain.transfers.length, 2);
});


test("a login holds no funds and a Stellar opening publishes one account with a private one-to-one pair", async () => {
  const { chain, service, owner } = await fixture();
  try {
    assert.deepEqual((await service.workspace(owner)).accounts, []);
    assert.equal(chain.wallets.size, 0);
    const first = (await service.openAccount(owner, { name: "First", type: "stellar", requestId: "first" })).account;
    const second = (await service.openAccount(owner, { name: "Second", type: "stellar", requestId: "second" })).account;
    assert.notEqual(chain.owners.get(first.id), chain.owners.get(second.id));
    const internalAddress = chain.wallet(chain.owners.get(first.id)!).address;
    const view = await service.workspace(owner);
    assert.equal(view.accounts.length, 2);
    assert.ok(view.accounts.every(a => a.rail === "blockchain" && StrKey.isValidContract(a.address!)));
    assert.equal(JSON.stringify(view).includes(internalAddress), false);
    assert.equal(JSON.stringify(view).includes("classicAccountId"), false);
    assert.equal("parent" in view, false);
    assert.equal("balances" in view.customer, false);
    const repeat = await service.openAccount(owner, { name: "First", type: "stellar", requestId: "first" });
    assert.equal(repeat.account.id, first.id);
    assert.equal(chain.wallets.size, 4);
  } finally { service.close(); }
});

test("Add funds deposits into the mapped wallet then automatically forwards exactly once", async () => {
  const { chain, service, owner } = await fixture();
  try {
    const account = (await service.openAccount(owner, { name: "Stellar", type: "stellar", requestId: "stellar" })).account;
    const second = (await service.openAccount(owner, { name: "Second", type: "stellar", requestId: "second" })).account;
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
  const { chain, owner } = fixtureResult;
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


test("HTTP sessions protect management routes and public payments use only the secret mandate ID", async t => {
  const { service } = await fixture();
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
  const open = async (name: string) => {
    const response = await send("/accounts/open", { name, type: "traditional", requestId: name }, session);
    assert.equal(response.status, 201);
    return (await response.json() as { account: { id: string; address: string } }).account;
  };
  const source = await open("Source"); const seller = await open("Seller");
  assert.equal((await send(`/accounts/${source.id}/funding`, { amount: "10", requestId: "fund" }, { ...session, origin: "https://other.example" })).status, 403);
  assert.equal((await send(`/accounts/${source.id}/funding`, { amount: "10", requestId: "fund" }, session)).status, 201);
  const grant = await send("/mandates", { accountId: source.id, name: "HTTP agent", recipientType: "agent", recipient: "api-agent", limit: "3", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "grant" }, session);
  assert.equal(grant.status, 201);
  const result = await grant.json() as { mandateId: string; mandate: { reference: string } };
  const payment = { mandateId: result.mandateId, sellerAddress: seller.address, sellerName: "Seller", amount: "2", reference: "Supplies", requestId: "purchase" };
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
  const { service, owner } = await fixture();
  try {
    const registered = await service.register({ name: "Holder", email: "holder@example.com", password: "a secure holder password" });
    const holder = service.authenticate(registered.token);
    const source = (await service.openAccount(owner, { name: "Source", type: "traditional", requestId: "source" })).account;
    const seller = (await service.openAccount(owner, { name: "Seller", type: "traditional", requestId: "seller" })).account;
    await service.fund(owner, source.id, { amount: "50", requestId: "fund" });
    const created = await service.createMandate(owner, { accountId: source.id, name: "Allowance", recipientType: "person", recipient: "holder@example.com", limit: "10", period: "day", expiresAt: "2026-11-17T12:00:00Z", requestId: "grant" });
    const shared = await service.workspace(holder);
    assert.deepEqual(shared.accounts, []); assert.equal(shared.shared.length, 1);
    const payment = { accountId: source.id, mandateReference: created.mandate.reference, destination: seller.address, amount: "10", reference: "Supplies", requestId: "first" };
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
  const { service, owner, token } = await fixture();
  const server = createPaymentApp(service).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const send = (path: string, body: unknown, headers = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const source = (await service.openAccount(owner, { name: "Source", type: "traditional", requestId: "source" })).account;
  const seller = (await service.openAccount(owner, { name: "Seller", type: "traditional", requestId: "seller" })).account;
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
  const payment = { mandateId: created.mandateId, sellerAddress: seller.address, sellerName: "Seller", amount: "2", reference: "Invoice", requestId: "purchase" };
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
  const { chain, owner } = result;
  let service = result.service;
  try {
    const account = (await service.openAccount(owner, { name: "Source", type: "traditional", requestId: "source" })).account;
    const details = { accountId: account.id, name: "Purchasing", recipientType: "agent", recipient: "Buyer", limit: "10", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "mandate" };
    const created = await service.createMandate(owner, details);
    service.close();
    const { WorkspaceStore } = await import("./store.ts");
    const store = new WorkspaceStore(path);
    store.update(state => {
      const saved = state.mandates[0]!;
      Object.assign(saved, { tokenHash: saved.mandateIdHash });
      delete saved.mandateIdHash;
    });
    store.close();
    service = new StellarPaymentService(path, chain);
    assert.equal(service.revealMandate(owner, created.mandate.reference).mandateId, created.mandateId);
    assert.equal((await service.createMandate(owner, details)).mandateId, created.mandateId);
    assert.equal((await service.workspace(owner)).mandates.length, 1);
    assert.equal(readFileSync(path).includes(Buffer.from(created.mandateId)), false);
  } finally { service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Add funds directly confirms the entered demo USD amount and processes retries once", async t => {
  const { chain, service, owner, token } = await fixture();
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
    const { chain, owner } = fixtureResult;
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
  const { chain, service, owner } = await fixture();
  try {
    const bank = await service.createAccount(owner, { name: "Bank", type: "traditional", requestId: "bank" });
    const stellar = await service.createAccount(owner, { name: "Stellar", type: "stellar", requestId: "stellar" });
    assert.equal(bank.currency, "USD"); assert.equal(stellar.currency, "USD");
    await service.fund(owner, bank.id, { amount: "10", requestId: "bank-funding" });
    await service.fund(owner, stellar.id, { amount: "5", requestId: "stellar-funding" });
    chain.balances.set(stellar.address!, 900_000_000n);
    await service.pay(owner, { accountId: bank.id, destination: stellar.address, amount: "2", reference: "USD", requestId: "usd" });
    const view = await service.workspace(owner);
    assert.ok(view.accounts.every(account => account.currency === "USD" && !("balances" in account)));
    assert.equal(view.accounts.find(account => account.id === stellar.id)!.balance, "7");
    assert.equal(view.network!.currency, "USD");
    const details = { accountId: stellar.id, name: "Dollars", recipientType: "agent", recipient: "Buyer", limit: "1", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "usd-grant" };
    const created = await service.createMandate(owner, details);
    assert.equal(created.mandate.currency, "USD");
    assert.equal(chain.rules.get(created.mandate.ruleId!)!.currency, "USD");
    await assert.rejects(service.createMandate(owner, { ...details, currency: "XLM", requestId: "xlm-grant" }), { status: 400 });
    const input = { mandateId: created.mandateId, sellerAddress: bank.address, amount: "0.5", reference: "Return dollars", requestId: "return" };
    assert.equal((await service.previewMandatePayment(input)).currency, "USD");
    assert.equal((await service.payWithMandate({ ...input, accountId: bank.id, currency: "XLM" })).currency, "USD");
    assert.equal(chain.transfers.at(-1)!.source, stellar.address);
    assert.equal(chain.transfers.at(-1)!.currency, "USD");
    await assert.rejects(service.pay(owner, { accountId: stellar.id, currency: "XLM", destination: bank.address, amount: "0.5", reference: "Wrong asset", requestId: "wrong-currency" }), { status: 400 });
    assert.equal(await chain.balance(chain.wallet(stellar.id), "XLM"), 900_000_000n);
    assert.equal((await service.workspace(owner)).accounts.find(account => account.id === stellar.id)!.balance, "6.5");
  } finally { service.close(); }
});

test("legacy demo accounts upgrade their balance exactly once after interrupted forwarding and retire service-only mandates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mandate-legacy-upgrade-"));
  const path = join(directory, "workspace.sqlite");
  const fixtureResult = await fixture(path);
  const { chain, owner } = fixtureResult;
  let service = fixtureResult.service;
  const store = new WorkspaceStore(path);
  try {
    store.update(state => {
      state.accounts.push({ id: "legacy-bank", ownerId: owner.id, name: "Old demo", type: "traditional", rail: "traditional", balance: "25.50", currency: "USD", address: "BANK_DEMO_OLD", createdAt: new Date().toISOString() });
      state.mandates.push({ id: "legacy-mandate", accountId: "legacy-bank", name: "Old grant", recipientType: "agent", recipient: "Buyer", limit: "10", spent: "0", period: "day", status: "active", expiresAt: new Date(Date.now() + 86400_000).toISOString(), createdAt: new Date().toISOString(), enforcement: "service" });
    });
    chain.failFunding = true;
    await assert.rejects(service.workspace(owner));
    assert.equal(store.read().mandates[0]!.status, "revoked");
    assert.equal(chain.deposits.length, 1);
    assert.equal(store.read().traditionalUpgrades![0]!.completed, false);
    service.close(); service = new StellarPaymentService(path, chain);
    chain.failFunding = false;
    const view = await service.workspace(owner);
    assert.equal(view.accounts.length, 1);
    assert.ok(StrKey.isValidContract(view.accounts[0]!.address!));
    assert.equal(view.accounts[0]!.balance, "25.5");
    assert.equal(view.mandates[0]!.status, "revoked");
    assert.equal(chain.deposits.length, 1); assert.equal(chain.transfers.length, 1);
    await service.workspace(owner);
    assert.equal(chain.deposits.length, 1); assert.equal(store.read().traditionalUpgrades![0]!.completed, true);
  } finally { store.close(); service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("legacy Stellar metadata and cached openings expose USD without reinterpreting existing XLM rules", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mandate-usd-default-"));
  const path = join(directory, "workspace.sqlite");
  const { chain, service, owner } = await fixture(path);
  const store = new WorkspaceStore(path);
  try {
    const account = await service.createAccount(owner, { name: "Existing Stellar", type: "stellar", requestId: "existing" });
    const seller = await service.createAccount(owner, { name: "Recipient", type: "traditional", requestId: "seller" });
    const details = { accountId: account.id, name: "Legacy", recipientType: "agent", recipient: "Buyer", limit: "2", period: "day", expiresAt: new Date(Date.now() + 86400_000).toISOString(), requestId: "old-mandate" };
    const legacy = await service.createMandate(owner, details);
    store.update(state => {
      state.accounts.find(saved => saved.id === account.id)!.currency = "XLM";
      delete state.mandates.find(saved => saved.id === legacy.mandate.reference)!.currency;
    });
    chain.rules.get(legacy.mandate.ruleId!)!.currency = "XLM";
    chain.balances.set(account.address!, 500_000_000n);
    chain.usdBalances.set(account.address!, 30_000_000n);
    const cached = chain.commands.get(`${owner.id}:stellar-opening:existing`)!;
    cached.result = { ...account, currency: "XLM", balance: "50" };
    const reopened = await service.createAccount(owner, { name: "Existing Stellar", type: "stellar", requestId: "existing" });
    assert.equal(reopened.currency, "USD"); assert.equal(reopened.balance, "3");
    const view = await service.workspace(owner);
    assert.equal(view.accounts[0]!.currency, "USD"); assert.equal(view.accounts[0]!.balance, "3");
    assert.equal("balances" in view.accounts[0]!, false);
    assert.equal(view.mandates[0]!.currency, "XLM");
    await assert.rejects(service.previewMandatePayment({ mandateId: legacy.mandateId, sellerAddress: seller.address, amount: "1" }), { status: 400 });
    await service.fund(owner, account.id, { amount: "1", requestId: "new-funding" });
    const usd = await service.createMandate(owner, { ...details, requestId: "new-usd-mandate" });
    assert.equal(usd.mandate.currency, "USD");
    assert.equal((await service.payWithMandate({ mandateId: usd.mandateId, sellerAddress: seller.address, amount: "0.5", reference: "USD", requestId: "usd-payment" })).currency, "USD");
    assert.equal(await chain.balance(chain.wallet(account.id), "USD"), 35_000_000n);
    assert.equal(await chain.balance(chain.wallet(account.id), "XLM"), 500_000_000n);
  } finally { store.close(); service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("one account can be opened without a type and funded by FIAT or automatic Testnet", async () => {
  const { chain, service, owner } = await fixture();
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
