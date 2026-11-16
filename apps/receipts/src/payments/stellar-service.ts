import { createHash, randomBytes } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";
import { formatAmount, toBaseUnits } from "@mandate/shared";
import type { AccountAgent, AccountMandate, AccountOpening, FiatCheckout, FiatFundingStatus, FundingMethod, MandateCreation, MandatePaymentPreview, PaymentEntry, PaymentWorkspace, SpendingAccount } from "@mandate/shared";
import { WorkspaceStore, ServiceError, amount, requireThat, text, validateMandateInput, type Actor, type EntryRecord, type MandateRecord, type StellarAccountPair, publicEntry } from "./store.ts";
import type { ChainGateway, ChainReceipt } from "./stellar.ts";
import { fundingAmount } from "./funding.ts";
import { StripeSandbox, type FiatGateway, type StripeSession } from "./stripe.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const timestamp = () => new Date().toISOString();
const decimal = (value: bigint) => formatAmount(value.toString());
type ChatSetup = MandateCreation & { agent: AccountAgent };


/** Auth and account ownership stay local; money and smart-account rules live on Stellar. */
export class StellarPaymentService {
  readonly network;
  private core: WorkspaceStore;
  private chain: ChainGateway;
  private chatSetups = new Map<string, Promise<ChatSetup>>();
  private stripe: FiatGateway;
  constructor(path: string, chain: ChainGateway, stripe: FiatGateway = new StripeSandbox()) {
    this.core = new WorkspaceStore(path);
    this.chain = chain;
    this.stripe = stripe;
    const usd = chain.network.assets?.find(asset => asset.currency === "USD");
    this.network = { ...chain.network, currency: "USD", tokenContract: usd?.tokenContract ?? chain.network.tokenContract, assets: usd ? [usd] : undefined };
  }
  close() { this.core.close(); this.chain.close(); }
  async register(body: Record<string, unknown>) {
    const result = await this.core.register(body);
    try { await this.defaultChatSetup(this.core.authenticate(result.token)); }
    catch (error) {
      this.core.logout(result.token);
      throw new ServiceError(503, "Your login was created, but account setup is still pending. Sign in to resume setup.", error instanceof ServiceError ? error.txHash : undefined);
    }
    return result;
  }
  async login(body: Record<string, unknown>) {
    const result = await this.core.login(body);
    try { await this.defaultChatSetup(this.core.authenticate(result.token)); }
    catch (error) { this.core.logout(result.token); throw error; }
    return result;
  }
  authenticate(token: string) { return this.core.authenticate(token); }
  logout(token: string) { return this.core.logout(token); }
  private customer(actor: Actor) {
    const found = actor.kind === "customer" && this.core.read().customers.find(c => c.id === actor.id);
    requireThat(found, 403, "Sign in to manage your financial accounts");
    return found;
  }
  private owned(actor: Actor, id: unknown) {
    const customer = this.customer(actor);
    const found = this.core.read().accounts.find(a => a.ownerId === customer.id && a.id === id);
    requireThat(found, 404, "Account not found");
    return found;
  }
  private assertPairs(pairs: StellarAccountPair[]) {
    requireThat(new Set(pairs.map(p => p.accountId)).size === pairs.length && new Set(pairs.map(p => p.classicWalletId)).size === pairs.length, 409, "Stellar account mapping must be one to one");
  }
  private pair(account: SpendingAccount) {
    const pair = this.core.read().stellarPairs.find(p => p.accountId === account.id);
    requireThat(pair, 409, "Stellar account setup is incomplete. Retry opening the account.");
    return pair;
  }
  private classicWallet(account: SpendingAccount) {
    const pair = this.pair(account);
    return this.chain.wallet(pair.classicWalletId);
  }
  private commandId(actor: Actor, kind: string, requestId: unknown) {
    return `${actor.id}:${kind}:${text(requestId, "Idempotency key", 128)}`;
  }
  private decorate(account: SpendingAccount): SpendingAccount {
    const wallet = this.chain.wallet(account.id);
    const { balances: _legacyBalances, ...details } = account as SpendingAccount & { balances?: unknown };
    return { ...details, sellerId: this.core.read().accounts.find(saved => saved.id === account.id)?.sellerId, currency: "USD", address: wallet.address, network: this.network.id, explorerUrl: `${this.network.explorerUrl}/contract/${wallet.address}` };
  }
  private record(input: Omit<EntryRecord, "id" | "createdAt" | "settlement">, receipt: ChainReceipt): PaymentEntry {
    const id = receipt.txHash;
    return this.core.update(state => {
      let entry = state.entries.find(e => e.id === id);
      if (!entry) {
        entry = { ...input, id, createdAt: timestamp(), settlement: "stellar-testnet", txHash: receipt.txHash, explorerUrl: `${this.network.explorerUrl}/tx/${receipt.txHash}` };
        state.entries.push(entry);
      }
      return publicEntry(entry);
    });
  }
  async workspace(actor: Actor): Promise<PaymentWorkspace> {
    await this.mainAccount(actor);
    // Upgrade old local demo accounts without exposing the custody layers.
    const initial = this.core.workspace(actor);
    for (const account of [...initial.accounts, ...initial.shared.map(shared => shared.account)]) {
      if (!account.address || !StrKey.isValidContract(account.address) || this.upgradePending(account.id)) await this.upgradeTraditional(account);
    }
    const state = this.core.read();
    const chatAgentId = `agt_${digest(this.commandId(actor, "agent", "default-chat")).slice(0, 32)}`;
    const chatMandateId = digest(this.commandId(actor, "mandate", "default-chat")).slice(0, 32);
    if (!state.agents?.some(agent => agent.id === chatAgentId) || !state.mandates.some(mandate => mandate.id === chatMandateId)) {
      await this.defaultChatSetup(actor);
    }
    const view = this.core.workspace(actor);
    const accounts = new Map<string, SpendingAccount>();
    for (const account of [...view.accounts, ...view.shared.map(s => s.account)]) accounts.set(account.id, account);
    await Promise.all([...accounts.values()].map(async account => {
      const wallet = this.chain.wallet(account.id);
      const [verified, balance] = await Promise.all([
        this.chain.isVerifiedSmartAccount(wallet.address),
        this.chain.balance(wallet, "USD"),
      ]);
      accounts.set(account.id, { ...this.decorate(account), balance: decimal(balance), verified, verificationSource: "on-chain" });
    }));
    const mandates = new Map<string, AccountMandate>();
    for (const mandate of [...view.mandates, ...view.shared.map(s => s.mandate)]) mandates.set(mandate.reference, mandate);
    await Promise.all([...mandates.values()].map(async mandate => {
      mandate.currency ??= this.core.read().accounts.find(account => account.id === mandate.accountId)?.currency;
      if (mandate.status === "active" && mandate.enforcement === "on-chain" && mandate.ruleId !== undefined) {
        mandate.spent = decimal(await this.chain.spent(this.chain.wallet(mandate.accountId), mandate.ruleId));
      }
    }));
    return {
      ...view, mode: "stellar-testnet", network: this.network,
      agents: await Promise.all(view.agents.map(async agent => ({ ...agent, verified: await this.chain.isVerifiedAgent(this.chain.wallet(agent.accountId).address, agent.id) }))),
      accounts: view.accounts.map(a => accounts.get(a.id)!),

      mandates: view.mandates.map(m => mandates.get(m.reference)!),
      shared: view.shared.map(s => ({ ...s, account: accounts.get(s.account.id)!, mandate: mandates.get(s.mandate.reference)! })),
    };
  }
  async createAgent(actor: Actor, body: Record<string, unknown>): Promise<AccountAgent> {
    const account = await this.mainAccount(actor);
    const name = text(body.name, "Agent name");
    const commandId = this.commandId(actor, "agent", body.requestId);
    const id = `agt_${digest(commandId).slice(0, 32)}`;
    return this.chain.command(commandId, { accountId: account.id, name }, async () => {
      const receipt = await this.chain.registerAgent(id, this.chain.wallet(account.id), id, name);
      const agent: AccountAgent = { id, accountId: account.id, name, createdAt: timestamp(), verified: true, verificationTxHash: receipt.txHash, explorerUrl: `${this.network.explorerUrl}/tx/${receipt.txHash}` };
      this.core.update(state => { const agents = state.agents ??= []; if (!agents.some(saved => saved.id === id)) agents.push(agent); });
      return agent;
    });
  }
  /** Stable command ID makes signup, login recovery and concurrent chats reuse one identity. */
  async defaultChatAgent(actor: Actor): Promise<AccountAgent> {
    return this.createAgent(actor, { name: "Chat agent", requestId: "default-chat" });
  }
  async defaultChatSetup(actor: Actor): Promise<ChatSetup> {
    const ownerId = this.customer(actor).id;
    const existing = this.chatSetups.get(ownerId);
    if (existing) return existing;
    const setup = this.provisionChatSetup(actor);
    this.chatSetups.set(ownerId, setup);
    try { return await setup; }
    finally { this.chatSetups.delete(ownerId); }
  }
  private async provisionChatSetup(actor: Actor): Promise<ChatSetup> {
    const agent = await this.defaultChatAgent(actor);
    const reference = digest(this.commandId(actor, "mandate", "default-chat")).slice(0, 32);
    const state = this.core.read();
    const existing = state.mandates.find(mandate => mandate.id === reference);
    if (existing) {
      // Never renew expired access or recreate a mandate the owner has revoked.
      return { agent, mandate: this.core.mandateView(state, existing), ...this.revealMandate(actor, reference) };
    }
    // Reserve expiry before chain work so interrupted setup can reuse identical details.
    const expiresAt = this.core.update(state => {
      const customer = state.customers.find(customer => customer.id === actor.id)!;
      customer.defaultChatMandateExpiresAt ??= new Date(Date.now() + 30 * 86400_000).toISOString();
      return customer.defaultChatMandateExpiresAt;
    });
    const created = await this.createMandate(actor, {
      name: "Chat mandate", recipientType: "agent", recipient: agent.id,
      limit: "1", period: "day", expiresAt, requestId: "default-chat",
    });
    return { agent, ...created };
  }
  private async paymentAgent(accountId: string, value: unknown) {
    requireThat(typeof value === "string" && value.trim().length > 0 && value.trim().length <= 128, 401, "Agent identification is required");
    const id = value.trim();
    const account = this.core.read().accounts.find(account => account.id === accountId);
    requireThat(account?.address && await this.chain.isVerifiedAgent(account.address, id), 403, "Agent identity is not registered to this account on chain");
    const agent = this.core.read().agents?.find(agent => agent.id === id && agent.accountId === accountId);
    return { id, name: agent?.name ?? id, verified: true };
  }
  /** Legacy opening requests resolve to the main account instead of creating another. */
  async createAccount(actor: Actor, body: Record<string, unknown>): Promise<SpendingAccount> {
    this.customer(actor);
    text(body.name, "Account name");
    const type = body.type ?? "stellar";
    requireThat(type === "traditional" || type === "stellar", 400, "Invalid account type");
    requireThat(!body.parentId && !body.classicAccountId, 400, "Account setup is managed automatically");
    requireThat(!body.rail || body.rail === (type === "traditional" ? "traditional" : "blockchain"), 400, "The account type and payment method do not match");
    text(body.requestId, "Idempotency key", 100);
    // Compatibility for older clients: opening always returns the user's main account.
    const created = await this.mainAccount(actor);
    return { ...this.decorate(created), balance: decimal(await this.chain.balance(this.chain.wallet(created.id), "USD")) };
  }
  private async mainAccount(actor: Actor): Promise<SpendingAccount> {
    const customer = this.customer(actor);
    // Reserve the identity before network work, so failures and concurrent requests
    // always resume the same wallet pair, including after a service restart.
    const id = customer.mainAccountId ?? this.core.update(state => {
      const saved = state.customers.find(c => c.id === customer.id)!;
      saved.mainAccountId ??= state.accounts.find(a => a.ownerId === customer.id)?.id ?? `STELLAR_${digest(`main:${customer.id}`).slice(0, 32)}`;
      return saved.mainAccountId;
    });
    const existing = this.core.read().accounts.find(a => a.id === id && a.ownerId === customer.id);
    if (existing) return existing;
    return this.chain.command(`${customer.id}:main-account`, { accountId: id }, async () => {
      const saved = this.core.read().accounts.find(a => a.id === id && a.ownerId === customer.id);
      return saved ?? this.provisionAccount({ id, ownerId: customer.id, name: "Main account", type: "stellar", rail: "blockchain", currency: "USD", balance: "0", createdAt: timestamp() });
    });
  }
  private async provisionAccount(account: SpendingAccount): Promise<SpendingAccount> {
    requireThat(this.network.verifiedSmartAccounts, 503, "Smart Accounts are not configured. Run pnpm setup:contracts.");
    const classic = this.chain.treasury(`classic:${account.id}`);
    await this.chain.faucet(classic);
    const created = await this.chain.createAccount(account.id, classic);
    const verification = await this.chain.verifySmartAccount(account.id, created, classic, "USD");
    const provisioned: SpendingAccount = { ...account, verified: true, verificationSource: "on-chain", verificationTxHash: verification.txHash, address: created.address, network: this.network.id, creationTxHash: created.txHash, balance: "0" };
    this.core.update(state => {
      if (!state.stellarPairs.some(pair => pair.accountId === account.id)) state.stellarPairs.push({ accountId: account.id, classicWalletId: classic.id });
      this.assertPairs(state.stellarPairs);
      const index = state.accounts.findIndex(existing => existing.id === account.id);
      if (index < 0) state.accounts.push(provisioned);
      else state.accounts[index] = { ...provisioned, sellerId: state.accounts[index]!.sellerId };
    });
    return { ...this.decorate(provisioned), balance: decimal(await this.chain.balance(created, account.currency)) };
  }
  private upgradePending(id: string) {
    return this.core.read().traditionalUpgrades?.some(upgrade => upgrade.accountId === id && !upgrade.completed) ?? false;
  }
  private async upgradeTraditional(account: SpendingAccount) {
    requireThat(account.type === "traditional", 409, "Account setup is incomplete");
    this.core.update(state => {
      const upgrades = state.traditionalUpgrades ??= [];
      if (!upgrades.some(upgrade => upgrade.accountId === account.id)) upgrades.push({ accountId: account.id, balance: account.balance, completed: false });
    });
    return this.chain.command(`upgrade:${account.id}`, { accountId: account.id }, async () => {
      const upgrade = this.core.read().traditionalUpgrades!.find(upgrade => upgrade.accountId === account.id)!;
      const provisioned = await this.provisionAccount({ id: account.id, ownerId: account.ownerId, name: account.name, rail: "traditional", type: "traditional", currency: "USD", balance: "0", createdAt: account.createdAt });
      // An old service mandate has no on-chain authorization. Retire it rather than reset its allowance.
      this.core.update(state => {
        for (const mandate of state.mandates.filter(mandate => mandate.accountId === account.id && mandate.enforcement === "service")) mandate.status = "revoked";
      });
      if (BigInt(toBaseUnits(upgrade.balance)) > 0n) await this.fundAccount({ kind: "customer", id: account.ownerId }, provisioned, BigInt(toBaseUnits(upgrade.balance)), `legacy-fiat:${account.id}`, "Existing demo balance");
      this.core.update(state => { state.traditionalUpgrades!.find(upgrade => upgrade.accountId === account.id)!.completed = true; });
      return provisioned;
    });
  }
  async openAccount(actor: Actor, body: Record<string, unknown>): Promise<AccountOpening> {
    return { account: await this.createAccount(actor, body) };
  }
  async fund(actor: Actor, id: string, body: Record<string, unknown>) {
    const method = body.method ?? "testnet";
    requireThat(method === "testnet", 400, "FIAT funding requires Stripe checkout and payment confirmation");
    let target = this.owned(actor, id);
    if (!target.address || !StrKey.isValidContract(target.address) || this.upgradePending(target.id)) { await this.upgradeTraditional(target); target = this.owned(actor, id); }
    requireThat(!body.sourceAccountId && !body.classicAccountId, 400, "Funding is managed automatically");
    const units = fundingAmount(body.amount);
    const commandId = this.commandId(actor, "add-funds", body.requestId);
    return this.chain.command(commandId, { accountId: id, amount: decimal(units), method }, () => this.fundAccount(actor, target, units, commandId, "Testnet funding", method));
  }
  async createFiatCheckout(actor: Actor, accountId: string, body: Record<string, unknown>): Promise<FiatCheckout> {
    const account = this.owned(actor, accountId);
    requireThat(!body.sourceAccountId && !body.classicAccountId, 400, "Funding is managed automatically");
    const units = fundingAmount(body.amount);
    const cents = Number(units / 100_000n);
    requireThat(cents >= 50 && cents <= 99_999_999, 400, "Stripe sandbox deposits must be between 0.50 and 999,999.99 USD");
    const id = `fiat_${digest(this.commandId(actor, "stripe-checkout", body.requestId))}`;
    const funding = this.core.update(state => {
      const records = state.fiatFunding ??= [];
      let saved = records.find(record => record.id === id);
      requireThat(!saved || (saved.accountId === account.id && saved.amount === decimal(units)), 409, "Idempotency key was used with different details");
      if (!saved) { saved = { id, ownerId: account.ownerId, accountId: account.id, amount: decimal(units), cents }; records.push(saved); }
      return saved;
    });
    const session = funding.sessionId ? await this.stripe.retrieve(funding.sessionId)
      : await this.stripe.create({ id, accountId: account.id, ownerId: account.ownerId, cents, email: this.customer(actor).email });
    this.validateFiatSession(session, funding);
    requireThat(session.status === "open" && session.url?.startsWith("https://checkout.stripe.com/"), 409, "This checkout is complete or expired. Check Activity or start a new deposit.");
    this.core.update(state => {
      const saved = state.fiatFunding!.find(record => record.id === id)!;
      requireThat(!saved.sessionId || saved.sessionId === session.id, 409, "Stripe checkout does not match the funding request");
      saved.sessionId = session.id;
    });
    return { status: "checkout", provider: "stripe", mode: "test", sessionId: session.id, url: session.url! };
  }
  private validateFiatSession(session: StripeSession, funding: { id: string; accountId: string; ownerId: string; cents: number }) {
    requireThat(session.livemode === false && session.mode === "payment", 400, "Only Stripe sandbox payments are supported");
    requireThat(session.currency === "usd" && session.amount_total === funding.cents
      && session.client_reference_id === funding.id && session.metadata?.fundingId === funding.id
      && session.metadata?.accountId === funding.accountId && session.metadata?.ownerId === funding.ownerId, 400, "Stripe payment does not match the funding request");
  }
  async fiatFundingStatus(actor: Actor, sessionId: string): Promise<FiatFundingStatus> {
    const customer = this.customer(actor);
    const funding = this.core.read().fiatFunding?.find(record => record.sessionId === sessionId && record.ownerId === customer.id);
    requireThat(funding, 404, "Funding checkout not found");
    return this.settleFiatCheckout(sessionId);
  }
  async stripeWebhook(payload: Buffer, signature: string) {
    const event = this.stripe.verifyEvent(payload, signature);
    requireThat(event.livemode === false, 400, "Live Stripe events are disabled");
    if (!["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) return;
    // Ignore unrelated sessions from the same Stripe sandbox.
    if (!event.sessionId || !this.core.read().fiatFunding?.some(record => record.sessionId === event.sessionId)) return;
    await this.settleFiatCheckout(event.sessionId);
  }
  private async settleFiatCheckout(sessionId: string): Promise<FiatFundingStatus> {
    const funding = this.core.read().fiatFunding?.find(record => record.sessionId === sessionId);
    requireThat(funding, 404, "Funding checkout not found");
    const existing = funding.paymentId && this.core.read().entries.find(entry => entry.id === funding.paymentId);
    if (existing) return { status: "paid", payment: publicEntry(existing) };
    const session = await this.stripe.retrieve(sessionId);
    requireThat(session.id === sessionId, 400, "Stripe checkout does not match the funding request");
    this.validateFiatSession(session, funding);
    if (session.status === "expired") return { status: "expired" };
    if (session.status !== "complete" || session.payment_status !== "paid") return { status: "pending" };
    const actor: Actor = { kind: "customer", id: funding.ownerId };
    let target = this.owned(actor, funding.accountId);
    if (!target.address || !StrKey.isValidContract(target.address) || this.upgradePending(target.id)) { await this.upgradeTraditional(target); target = this.owned(actor, target.id); }
    const units = fundingAmount(funding.amount);
    const commandId = `stripe-funding:${sessionId}`;
    const payment = await this.chain.command(commandId, { accountId: target.id, amount: funding.amount, sessionId },
      () => this.fundAccount(actor, target, units, commandId, "Stripe sandbox funding", "fiat", sessionId));
    this.core.update(state => { state.fiatFunding!.find(record => record.id === funding.id)!.paymentId = payment.id; });
    return { status: "paid", payment };
  }
  private async fundAccount(actor: Actor, target: SpendingAccount, units: bigint, commandId: string, reference = "Account funding", method: FundingMethod = "testnet", stripeSessionId?: string) {
    const currency = "USD";
    const source = this.chain.treasury(this.pair(target).classicWalletId);
    if (!this.chain.hasTransaction(commandId) && await this.chain.balance(source) === 0n) await this.chain.faucet(source);
    await this.chain.deposit(commandId, source, units, currency);
    const destination = this.chain.wallet(target.id);
    const receipt = await this.chain.transfer(commandId, source, source, destination.address, units, undefined, currency);
    return this.record({ ownerId: target.ownerId, actorId: actor.id, accountId: target.id, source: method === "fiat" ? "Stripe sandbox payment" : "Stellar testnet funding", destination: destination.address, kind: "funding", amount: decimal(units), currency, mandateId: null, reference, requestId: commandId, ...(stripeSessionId ? { stripeSessionId } : {}) }, receipt);
  }
  async createMandate(actor: Actor, body: Record<string, unknown>) {
    const main = await this.mainAccount(actor);
    const account = this.owned(actor, body.accountId ?? main.id);
    requireThat(account.address && StrKey.isValidContract(account.address), 409, "Open the dashboard to finish setting up your account");
    requireThat(this.network.mandates, 503, "Run pnpm setup:contracts to configure verified-smart mandate payments");
    const commandId = this.commandId(actor, "mandate", body.requestId);
    const validated = validateMandateInput(body);
    if (validated.recipientType === "agent" && validated.recipient.startsWith("agt_")) {
      requireThat(this.core.read().agents?.some(agent => agent.id === validated.recipient && agent.accountId === account.id), 400, "Choose a mandate user from this account's agents");
    }
    const currency = this.currency(body.currency);
    const id = digest(commandId).slice(0, 32);
    const details = { accountId: account.id, currency, name: validated.name, recipient: validated.recipient, recipientType: validated.recipientType, limit: validated.limit, period: validated.period, expiresAt: validated.expiresAt, ...(validated.sellerIds ? { sellerIds: validated.sellerIds } : {}) };
    await this.chain.command(commandId, details, async () => {
      const { ruleId } = await this.chain.addMandate(id, this.classicWallet(account), this.chain.wallet(account.id), { name: validated.name, limit: BigInt(toBaseUnits(validated.limit)), period: validated.period!, expiresAt: validated.expiresAt, currency });
      const mandateId = this.chain.secret(`token:${id}`, () => `mnd_${randomBytes(32).toString("base64url")}`);
      const mandate: MandateRecord = { ...validated, id, accountId: account.id, ruleId, currency, spent: "0", status: "active", createdAt: timestamp(), enforcement: "on-chain", verifiedRecipientsOnly: true, mandateIdHash: digest(mandateId) };
      this.core.update(state => { if (!state.mandates.some(m => m.id === id)) state.mandates.push(mandate); });
      return { reference: id };
    });
    const state = this.core.read();
    const mandate = state.mandates.find(m => m.id === id)!;
    return { mandate: this.core.mandateView(state, mandate), ...this.revealMandate(actor, id) };
  }
  revealMandate(actor: Actor, reference: string) {
    const mandate = this.core.read().mandates.find(m => m.id === reference);
    requireThat(mandate, 404, "Mandate not found");
    this.owned(actor, mandate.accountId);
    const mandateId = this.chain.secret(`token:${reference}`, () => { throw new ServiceError(409, "The secret mandate ID is unavailable"); });
    requireThat(!mandate.mandateIdHash || digest(mandateId) === mandate.mandateIdHash, 409, "The secret mandate ID is unavailable");
    return { mandateId };
  }
  async revoke(actor: Actor, id: string) {
    const mandate = this.core.read().mandates.find(m => m.id === id);
    requireThat(mandate, 404, "Mandate not found");
    const account = this.owned(actor, mandate.accountId);
    await this.chain.command(`${actor.id}:revoke:${id}`, { id }, async () => {
      // Block service access immediately; keep revocation retryable until chain confirms.
      this.core.revoke(actor, id);
      if (mandate.ruleId !== undefined) {
        this.core.update(state => { state.mandates.find(m => m.id === id)!.chainRevocationPending = true; });
        await this.chain.revokeMandate(id, this.classicWallet(account), this.chain.wallet(account.id), mandate.ruleId);
        this.core.update(state => { state.mandates.find(m => m.id === id)!.chainRevocationPending = false; });
      }
      return { revoked: true };
    });
  }
  async pay(actor: Actor, body: Record<string, unknown>): Promise<PaymentEntry> {
    const units = amount(body.amount);
    const destination = text(body.destination, "Stellar recipient address", 56);
    const reference = text(body.reference, "Payment reference", 200);
    const commandId = this.commandId(actor, "payment", body.requestId);
    return this.chain.command(commandId, { accountId: body.accountId, mandateId: body.mandateReference ?? null, ...(body.agentId === undefined ? {} : { agentId: body.agentId }), destination, amount: decimal(units), reference, currency: body.currency ?? null }, async () => {
      const state = this.core.read();
      const account = state.accounts.find(a => a.id === body.accountId);
      requireThat(account, 404, "Account not found");
      let mandate: MandateRecord | undefined;
      let agent: Awaited<ReturnType<StellarPaymentService["paymentAgent"]>> | undefined;
      if (actor.kind === "mandate" || actor.id !== account.ownerId || body.mandateReference) {
        mandate = state.mandates.find(m => m.id === (actor.kind === "mandate" ? actor.mandateReference : body.mandateReference) && m.accountId === account.id);
        const customer = actor.kind === "customer" ? this.customer(actor) : undefined;
        requireThat(mandate && (actor.kind === "mandate" || actor.id === account.ownerId || (mandate.recipientType === "person" && mandate.recipient === customer?.email)), 403, "You do not have a mandate for this account");
        requireThat(mandate.status === "active" && mandate.expiresAt > timestamp(), 403, "This mandate has expired or been revoked");
        agent = await this.paymentAgent(account.id, body.agentId);
      }
      requireThat(account.address && StrKey.isValidContract(account.address), 409, "Open the dashboard to finish setting up your account");
      const currency = this.currency(mandate ? mandate.currency ?? account.currency : body.currency);
      requireThat(!mandate || !body.currency || body.currency === currency, 400, "The payment currency does not match this mandate");
      const recovering = this.chain.hasTransaction(commandId);
      if (mandate) {
        requireThat(mandate.ruleId !== undefined, 409, "The mandate payment rule is missing");
        requireThat(mandate.status === "active" && mandate.expiresAt > timestamp(), 403, "This mandate has expired or been revoked");
        if (!recovering) {
          requireThat(this.sellerAllowed(mandate, destination), 403, "Seller is not in this mandate's allowed seller ID list");
          const spent = await this.chain.spent(this.chain.wallet(account.id), mandate.ruleId);
          requireThat(spent + units <= BigInt(toBaseUnits(mandate.limit)), 403, "Payment exceeds the mandate's spending limit");
        }
      }
      if (!recovering) {
        requireThat(StrKey.isValidContract(destination), 400, "Smart accounts and mandates can only pay Smart C-address accounts");
        requireThat(destination !== this.chain.wallet(account.id).address, 400, "Choose a different recipient account. Paying the source account would leave its balance unchanged.");
        requireThat(await this.chain.isVerifiedSmartAccount(destination), 403, "Seller is not a verified smart account");
        requireThat(await this.chain.isVerifiedSmartAccount(this.chain.wallet(account.id).address), 403, "The sending smart account is not verified");
        requireThat(await this.chain.balance(this.chain.wallet(account.id), currency) >= units, 409, "Insufficient account balance");
      }
      const treasury = this.classicWallet(account);
      const source = this.chain.wallet(account.id);
      const receipt = await this.chain.transfer(commandId, treasury, source, destination, units, mandate?.ruleId !== undefined ? { id: mandate.id, ruleId: mandate.ruleId, agentId: agent!.id } : undefined, currency);
      return this.record({ ownerId: account.ownerId, actorId: agent?.id ?? actor.id, accountId: account.id, source: source.address, destination, kind: "payment", amount: decimal(units), currency, mandateId: mandate?.id ?? null, ...(agent ? { agentId: agent.id } : {}), reference, requestId: String(body.requestId) }, receipt);
    });
  }
  private currency(value: unknown): string {
    const currency = value ?? "USD";
    requireThat(currency === "USD", 400, "Payments and mandates use USD. Create a new USD mandate to replace an older XLM mandate.");
    return currency;
  }
  private sellerAllowed(mandate: MandateRecord, address: string): boolean {
    if (!mandate.sellerIds?.length) return true;
    // Resolve the actual payment destination; never trust a caller-supplied seller ID or name.
    const seller = this.core.read().accounts.find(account => account.address === address);
    return seller?.sellerId !== undefined && mandate.sellerIds.includes(seller.sellerId);
  }
  private async paymentMandate(value: unknown, agentId: unknown) {
    const actor = this.core.authenticateMandate(value);
    requireThat(actor.kind === "mandate", 401, "Enter a valid secret mandate ID");
    const mandate = this.core.read().mandates.find(m => m.id === actor.mandateReference)!;
    requireThat(mandate.verifiedRecipientsOnly && mandate.ruleId !== undefined, 403, "A verified-recipient payment mandate is required");
    const agent = await this.paymentAgent(mandate.accountId, agentId);
    return { actor, mandate, agent };
  }
  async previewMandatePayment(body: Record<string, unknown>): Promise<MandatePaymentPreview> {
    const { mandate, agent } = await this.paymentMandate(body.mandateId, body.agentId);
    const state = this.core.read();
    const source = state.accounts.find(a => a.id === mandate.accountId)!;
    const currency = this.currency(mandate.currency ?? source.currency);
    const sellerAddress = text(body.sellerAddress, "Seller smart-account address", 56);
    const sellerName = text(body.sellerName || "Seller", "Seller name");
    const units = amount(body.amount);
    const wallet = this.chain.wallet(mandate.accountId);
    const [verified, balance, spent] = await Promise.all([
      this.chain.isVerifiedSmartAccount(sellerAddress), this.chain.balance(wallet, currency), this.chain.spent(wallet, mandate.ruleId!),
    ]);
    return {
      agent,
      mandate: { name: mandate.name, address: wallet.address, limit: mandate.limit, spent: decimal(spent), expiresAt: mandate.expiresAt },
      seller: { address: sellerAddress, name: sellerName, verified }, currency, balance: decimal(balance),
      checks: [
        { label: "Agent identity is registered to the source account on chain", passed: agent.verified },
        { label: "Mandate is active and has not expired", passed: mandate.status === "active" && mandate.expiresAt > timestamp() },
        { label: "Seller is a verified smart account", passed: verified },
        ...(mandate.sellerIds?.length ? [{ label: "Seller is in the mandate's allowed seller ID list", passed: this.sellerAllowed(mandate, sellerAddress) }] : []),
        { label: "Recipient is different from the source account", passed: sellerAddress !== wallet.address },
        { label: "Payment is within the remaining spending limit", passed: spent + units <= BigInt(toBaseUnits(mandate.limit)) },
        { label: "Mandate account has sufficient funds", passed: balance >= units },
      ],
    };
  }
  async payWithMandate(body: Record<string, unknown>): Promise<PaymentEntry> {
    const { actor, mandate, agent } = await this.paymentMandate(body.mandateId, body.agentId);
    return this.pay(actor, { accountId: mandate.accountId, mandateReference: mandate.id, agentId: agent.id, amount: body.amount, destination: body.sellerAddress, reference: body.reference, requestId: body.requestId });
  }
}
