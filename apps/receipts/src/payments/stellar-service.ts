import { createHash, randomBytes, randomInt } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { agentSigningPayload, formatAmount, NETWORK, toBaseUnits } from "@mandate/shared";
import type { AgentConnection, AgentMandate, AgentPaymentOutcome, AgentSellerCheck, PreparedAgentPayment } from "@mandate/shared";
import type { AccountAgent, AccountMandate, AccountOpening, FiatCheckout, FiatFundingStatus, FundingMethod, MandateCreation, MandatePaymentPreview, PaymentEntry, PaymentWorkspace, SpendingAccount } from "@mandate/shared";
import { WorkspaceStore, ServiceError, amount, requireThat, text, validateMandateInput, type Actor, type EntryRecord, type MandateRecord, type StellarAccountPair, type AgentRecord, publicEntry } from "./store.ts";
import type { ChainGateway, ChainReceipt } from "./stellar.ts";
import { fundingAmount } from "./funding.ts";
import { StripeSandbox, type FiatGateway, type StripeSession } from "./stripe.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const timestamp = () => new Date().toISOString();
const decimal = (value: bigint) => formatAmount(value.toString());
type ChatSetup = MandateCreation & { agent: AccountAgent };
const PAIRING_MINUTES = 30;
/** "K7Q4-92XD": eight characters, no lookalikes (0/O, 1/I). */
function pairingCode(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const part = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("");
  return `${part()}-${part()}`;
}
const normalizeCode = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, "");
export interface AgentRequestSignature { key?: string; time?: string; signature?: string }


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
      agents: await Promise.all(view.agents.map(async agent => this.agentView(agent, agent.status === "waiting" || agent.status === "revoked" ? false : await this.chain.isVerifiedAgent(this.chain.wallet(agent.accountId).address, agent.id)))),
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
    if (body.connect === true) {
      // The agent brings its own key: nothing goes on chain until it connects with the code.
      await this.chain.command(commandId, { accountId: account.id, name, connect: true }, async () => {
        const code = this.chain.secret(`pairing:${id}:1`, () => pairingCode());
        const agent: AgentRecord = { id, accountId: account.id, name, createdAt: timestamp(), verified: false, status: "waiting", pairingVersion: 1, pairingHash: digest(normalizeCode(code)), pairingExpiresAt: new Date(Date.now() + PAIRING_MINUTES * 60_000).toISOString() };
        this.core.update(state => { const agents = state.agents ??= []; if (!agents.some(saved => saved.id === id)) agents.push(agent); });
        return { id };
      });
      return this.agentView(this.agentRecord(id), false);
    }
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
      : await this.stripe.create({ id, accountId: account.id, ownerId: account.ownerId, cents, email: this.customer(actor).email, returnOrigin: typeof body.returnOrigin === "string" ? body.returnOrigin : undefined });
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
  /** Secret-ID mandates (people, keyless agents). For a connected agent use `grantMandate`. */
  async createMandate(actor: Actor, body: Record<string, unknown>): Promise<MandateCreation> {
    const created = await this.grantMandate(actor, body);
    requireThat(created.mandateId, 409, "This agent holds its own key, so its mandate has no secret ID");
    return { mandate: created.mandate, mandateId: created.mandateId };
  }
  /** A connected agent's mandate is signed only by its own key and has no secret ID. */
  async grantMandate(actor: Actor, body: Record<string, unknown>): Promise<{ mandate: AccountMandate; mandateId?: string }> {
    const main = await this.mainAccount(actor);
    const account = this.owned(actor, body.accountId ?? main.id);
    requireThat(account.address && StrKey.isValidContract(account.address), 409, "Open the dashboard to finish setting up your account");
    requireThat(this.network.mandates, 503, "Run pnpm setup:contracts to configure verified-smart mandate payments");
    const commandId = this.commandId(actor, "mandate", body.requestId);
    const validated = validateMandateInput(body.agentId === undefined ? body : { ...body, recipientType: "agent", recipient: text(body.agentId, "Agent", 128) });
    if (validated.recipientType === "agent" && validated.recipient.startsWith("agt_")) {
      requireThat(this.core.read().agents?.some(agent => agent.id === validated.recipient && agent.accountId === account.id), 400, "Choose a mandate user from this account's agents");
    }
    // A connected agent's own key becomes the rule's only signer. Mandate holds no key and no secret ID for it.
    const keyed = validated.recipientType === "agent" ? this.core.read().agents?.find(agent => agent.id === validated.recipient && agent.accountId === account.id && agent.status !== undefined) : undefined;
    requireThat(!keyed || keyed.status === "connected", 409, keyed?.status === "revoked" ? "This agent was removed. Add it again to give it a mandate." : "Connect the agent with its code before giving it a mandate");
    // It can pay without asking Mandate (x402), so its seller list must be enforced on chain.
    const sellers = keyed && validated.sellerIds?.length ? validated.sellerIds.map(sellerId => {
      const seller = this.core.read().accounts.find(saved => saved.sellerId === sellerId);
      requireThat(seller, 400, `Seller ID ${sellerId} does not belong to a Mandate account yet`);
      return this.chain.wallet(seller.id).address;
    }) : undefined;
    const currency = this.currency(body.currency);
    const id = digest(commandId).slice(0, 32);
    const details = { accountId: account.id, currency, name: validated.name, recipient: validated.recipient, recipientType: validated.recipientType, limit: validated.limit, period: validated.period, expiresAt: validated.expiresAt, ...(validated.sellerIds ? { sellerIds: validated.sellerIds } : {}) };
    await this.chain.command(commandId, details, async () => {
      const { ruleId } = await this.chain.addMandate(id, this.classicWallet(account), this.chain.wallet(account.id), { name: validated.name, limit: BigInt(toBaseUnits(validated.limit)), period: validated.period!, expiresAt: validated.expiresAt, currency, ...(keyed ? { agentKey: keyed.publicKey! } : {}), ...(sellers ? { sellers } : {}) });
      if (keyed) {
        const mandate: MandateRecord = { ...validated, id, accountId: account.id, ruleId, currency, spent: "0", status: "active", createdAt: timestamp(), enforcement: "on-chain", verifiedRecipientsOnly: true, agentId: keyed.id };
        this.core.update(state => { if (!state.mandates.some(m => m.id === id)) state.mandates.push(mandate); });
        return { reference: id };
      }
      const mandateId = this.chain.secret(`token:${id}`, () => `mnd_${randomBytes(32).toString("base64url")}`);
      const mandate: MandateRecord = { ...validated, id, accountId: account.id, ruleId, currency, spent: "0", status: "active", createdAt: timestamp(), enforcement: "on-chain", verifiedRecipientsOnly: true, mandateIdHash: digest(mandateId) };
      this.core.update(state => { if (!state.mandates.some(m => m.id === id)) state.mandates.push(mandate); });
      return { reference: id };
    });
    const state = this.core.read();
    const mandate = state.mandates.find(m => m.id === id)!;
    if (mandate.agentId) return { mandate: this.core.mandateView(state, mandate) };
    return { mandate: this.core.mandateView(state, mandate), ...this.revealMandate(actor, id) };
  }
  revealMandate(actor: Actor, reference: string) {
    const mandate = this.core.read().mandates.find(m => m.id === reference);
    requireThat(mandate, 404, "Mandate not found");
    this.owned(actor, mandate.accountId);
    requireThat(!mandate.agentId, 409, "This mandate is signed by the agent's own key. It has no secret mandate ID.");
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
        requireThat(!mandate.agentId, 403, "Only the agent can pay with this mandate, using its own key");
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

  // ---------- agents that hold their own key ----------

  private agentRecord(id: string): AgentRecord {
    const found = this.core.read().agents?.find(agent => agent.id === id);
    requireThat(found, 404, "Agent not found");
    return found;
  }
  /** Public view: the waiting agent's code comes from the vault, never from the hash. */
  private agentView(agent: AccountAgent | AgentRecord, verified: boolean): AccountAgent {
    const record = this.core.read().agents?.find(saved => saved.id === agent.id) ?? agent as AgentRecord;
    const { pairingHash: _hash, pairingExpiresAt, pairingVersion, ...view } = record as AgentRecord;
    let pairing: AccountAgent["pairing"];
    // A missing code only hides it; the owner can make a new one.
    if (view.status === "waiting" && pairingExpiresAt) {
      try { pairing = { code: this.chain.secret(`pairing:${view.id}:${pairingVersion ?? 1}`, () => { throw new ServiceError(409, "missing"); }), expiresAt: pairingExpiresAt }; }
      catch { pairing = { code: "", expiresAt: new Date(0).toISOString() }; }
    }
    return { ...view, verified, ...(pairing ? { pairing } : {}) };
  }
  private ownedAgent(actor: Actor, id: string): AgentRecord {
    const agent = this.agentRecord(id);
    this.owned(actor, agent.accountId);
    return agent;
  }
  /** A new code for an agent whose code expired before it connected. */
  async newPairingCode(actor: Actor, id: string): Promise<AccountAgent> {
    const agent = this.ownedAgent(actor, id);
    requireThat(agent.status === "waiting", 409, "This agent is already connected");
    const version = (agent.pairingVersion ?? 1) + 1;
    const code = this.chain.secret(`pairing:${id}:${version}`, () => pairingCode());
    this.core.update(state => {
      const found = state.agents!.find(saved => saved.id === id)!;
      found.pairingVersion = version;
      found.pairingHash = digest(normalizeCode(code));
      found.pairingExpiresAt = new Date(Date.now() + PAIRING_MINUTES * 60_000).toISOString();
    });
    return this.agentView(this.agentRecord(id), false);
  }
  /** Removes the agent from the registry and revokes every mandate it holds. */
  async revokeAgent(actor: Actor, id: string): Promise<void> {
    const agent = this.ownedAgent(actor, id);
    const account = this.owned(actor, agent.accountId);
    // Block it here at once; the chain steps below stay retryable.
    this.core.update(state => {
      const found = state.agents!.find(saved => saved.id === id)!;
      found.status = "revoked"; found.verified = false;
      delete found.pairingHash; delete found.pairingExpiresAt;
    });
    for (const mandate of this.core.read().mandates.filter(m => (m.agentId === id || (m.recipientType === "agent" && m.recipient === id)) && (m.status === "active" || m.chainRevocationPending))) {
      await this.revoke(actor, mandate.id);
    }
    if (agent.verificationTxHash) await this.chain.command(`${actor.id}:agent-revoke:${id}`, { id }, async () => {
      await this.chain.revokeAgent(id, this.chain.wallet(account.id), id);
      return { revoked: true };
    });
  }
  /** Checks a signed agent request: the key signed this method, path, time and body. */
  verifyKey(headers: AgentRequestSignature, method: string, path: string, body: string): string {
    const { key, time, signature } = headers;
    requireThat(key && StrKey.isValidEd25519PublicKey(key) && time && signature, 401, "Sign this request with the agent's key");
    requireThat(Math.abs(Date.now() - Number(time)) < 5 * 60_000, 401, "The request signature is too old. Check the clock.");
    let valid = false;
    try { valid = Keypair.fromPublicKey(key).verify(Buffer.from(agentSigningPayload(method, path, time, digest(body))), Buffer.from(signature, "base64")); } catch { valid = false; }
    requireThat(valid, 401, "The request signature does not match the agent's key");
    return key;
  }
  /** The connected agent that signed this request. */
  agent(headers: AgentRequestSignature, method: string, path: string, body: string): AgentRecord {
    const key = this.verifyKey(headers, method, path, body);
    const agents = this.core.read().agents?.filter(saved => saved.publicKey === key) ?? [];
    // A key may be reused after its earlier agent was removed; the live one wins.
    const agent = agents.find(saved => saved.status === "connected") ?? agents[0];
    requireThat(agent, 401, "This key is not connected to Mandate. Connect it with a code from the dashboard.");
    requireThat(agent.status === "connected", 403, "The owner removed this agent");
    return agent;
  }
  /** The agent proves it holds `key` and redeems the owner's one-time code. Only then is it registered on chain. */
  async connectAgent(body: Record<string, unknown>, key: string): Promise<AgentConnection> {
    const code = normalizeCode(text(body.code, "Connection code", 20));
    const agent = this.core.read().agents?.find(saved => saved.status === "waiting" && saved.pairingHash === digest(code));
    requireThat(agent, 404, "That code is not valid. Check it, or make a new one in Mandate.");
    requireThat(agent.pairingExpiresAt && agent.pairingExpiresAt > timestamp(), 410, "That code expired. Make a new one in Mandate.");
    requireThat(!this.core.read().agents?.some(saved => saved.publicKey === key && saved.id !== agent.id && saved.status === "connected"), 409, "This key is already connected to another agent. Make a new key.");
    await this.chain.command(`connect:${agent.id}`, { key }, async () => {
      const receipt = await this.chain.registerAgent(`${agent.id}:key`, this.chain.wallet(agent.accountId), agent.id, agent.name, key);
      this.core.update(state => {
        const found = state.agents!.find(saved => saved.id === agent.id)!;
        Object.assign(found, { status: "connected", publicKey: key, verified: true, verificationTxHash: receipt.txHash, explorerUrl: `${this.network.explorerUrl}/tx/${receipt.txHash}` });
        delete found.pairingHash; delete found.pairingExpiresAt;
      });
      return { connected: true };
    });
    return this.agentConnection(this.agentRecord(agent.id));
  }
  agentConnection(agent: AgentRecord): AgentConnection {
    const state = this.core.read();
    const account = state.accounts.find(saved => saved.id === agent.accountId)!;
    const owner = state.customers.find(customer => customer.id === account.ownerId);
    requireThat(this.network.agentVerifier, 503, "Run pnpm setup:contracts to configure on-chain agent verification");
    return {
      agentId: agent.id, name: agent.name, ownerName: owner?.name ?? "", smartAccount: this.chain.wallet(account.id).address,
      agentVerifier: this.network.agentVerifier, asset: this.chain.usdToken(), network: NETWORK, rpcUrl: this.network.rpcUrl,
      ...(process.env.STORES_URL ? { storesUrl: process.env.STORES_URL } : {}),
    };
  }
  private async agentMandateView(mandate: MandateRecord): Promise<AgentMandate> {
    const view = this.core.mandateView(this.core.read(), mandate);
    const spent = view.status === "active" && mandate.ruleId !== undefined ? await this.chain.spent(this.chain.wallet(mandate.accountId), mandate.ruleId) : BigInt(toBaseUnits(view.spent));
    const limit = BigInt(toBaseUnits(mandate.limit));
    return {
      reference: mandate.id, name: mandate.name, ruleId: mandate.ruleId!, limit: mandate.limit, spent: decimal(spent),
      remaining: decimal(view.status === "active" && limit > spent ? limit - spent : 0n), period: mandate.period, expiresAt: mandate.expiresAt, status: view.status,
      ...(mandate.sellerIds?.length ? { sellerIds: mandate.sellerIds } : {}),
    };
  }
  async agentMandates(agent: AgentRecord): Promise<AgentMandate[]> {
    return Promise.all(this.core.read().mandates.filter(m => m.agentId === agent.id).map(m => this.agentMandateView(m)));
  }
  private agentMandate(agent: AgentRecord, reference: unknown): MandateRecord {
    const mandate = this.core.read().mandates.find(m => m.id === reference && m.agentId === agent.id);
    requireThat(mandate, 404, "This agent has no mandate with that reference");
    return mandate;
  }
  async checkSeller(_agent: AgentRecord, address: string): Promise<AgentSellerCheck> {
    requireThat(StrKey.isValidContract(address) || StrKey.isValidEd25519PublicKey(address), 400, "Enter a Stellar address");
    const state = this.core.read();
    const account = state.accounts.find(saved => this.chain.wallet(saved.id).address === address);
    const owner = account && state.customers.find(customer => customer.id === account.ownerId);
    return { address, verified: StrKey.isValidContract(address) && await this.chain.isVerifiedSmartAccount(address), ...(account?.sellerId !== undefined ? { sellerId: account.sellerId } : {}), ...(owner ? { name: owner.name } : {}) };
  }
  /** Every check the chain will make again; failing one here declines before anything is signed. */
  private async agentPaymentChecks(mandate: MandateRecord, seller: string, units: bigint) {
    const source = this.chain.wallet(mandate.accountId);
    requireThat(mandate.status === "active" && mandate.expiresAt > timestamp() && mandate.ruleId !== undefined, 403, "This mandate has expired or been revoked");
    requireThat(StrKey.isValidContract(seller), 403, "Mandates only pay verified smart accounts (C-addresses)");
    requireThat(seller !== source.address, 400, "The seller cannot be the account itself");
    requireThat(await this.chain.isVerifiedSmartAccount(seller), 403, "Seller is not a verified smart account");
    requireThat(this.sellerAllowed(mandate, seller), 403, "Seller is not in this mandate's allowed seller ID list");
    const [spent, balance] = await Promise.all([this.chain.spent(source, mandate.ruleId), this.chain.balance(source, "USD")]);
    requireThat(spent + units <= BigInt(toBaseUnits(mandate.limit)), 403, "Payment exceeds the mandate's spending limit");
    requireThat(balance >= units, 409, "Insufficient account balance");
  }
  /** Builds the transfer for the agent to sign. Mandate submits it and pays the fee, but cannot sign it. */
  async prepareAgentPayment(agent: AgentRecord, body: Record<string, unknown>): Promise<PreparedAgentPayment> {
    const mandate = this.agentMandate(agent, body.mandate);
    const seller = text(body.seller, "Seller address", 56);
    const units = amount(body.amount);
    const reference = text(body.reference, "Payment reference", 200);
    const paymentId = `agent-payment:${digest(`${agent.id}:${text(body.requestId, "Request ID", 128)}`)}`;
    const details = { mandate: mandate.id, seller, amount: decimal(units), reference };
    const saved = this.core.read().agentPayments?.find(payment => payment.id === paymentId);
    requireThat(!saved || JSON.stringify({ mandate: saved.mandateId, seller: saved.seller, amount: saved.amount, reference: saved.reference }) === JSON.stringify(details), 409, "Request ID was used with different details");
    if (!this.chain.hasTransaction(paymentId)) await this.agentPaymentChecks(mandate, seller, units);
    const account = this.core.read().accounts.find(saved => saved.id === mandate.accountId)!;
    const prepared = await this.chain.preparePayment(paymentId, this.classicWallet(account), this.chain.wallet(account.id), seller, units, mandate.ruleId!, "USD");
    this.core.update(state => {
      const payments = state.agentPayments ??= [];
      if (!payments.some(payment => payment.id === paymentId)) payments.push({ id: paymentId, agentId: agent.id, mandateId: mandate.id, seller, amount: decimal(units), reference, createdAt: timestamp() });
    });
    return {
      paymentId, authEntry: prepared.authEntry, expirationLedger: prepared.expirationLedger, ruleId: mandate.ruleId!,
      smartAccount: this.chain.wallet(account.id).address, agentVerifier: this.network.agentVerifier ?? "", networkPassphrase: "Test SDF Network ; September 2015",
      summary: { seller, amount: decimal(units), currency: "USD", reference },
    };
  }
  async submitAgentPayment(agent: AgentRecord, body: Record<string, unknown>): Promise<AgentPaymentOutcome> {
    const paymentId = text(body.paymentId, "Payment ID", 100);
    const pending = this.core.read().agentPayments?.find(payment => payment.id === paymentId && payment.agentId === agent.id);
    requireThat(pending, 404, "Prepare this payment first");
    const mandate = this.agentMandate(agent, pending.mandateId);
    const account = this.core.read().accounts.find(saved => saved.id === mandate.accountId)!;
    const units = BigInt(toBaseUnits(pending.amount));
    if (!this.chain.hasTransaction(paymentId)) await this.agentPaymentChecks(mandate, pending.seller, units);
    const signed = text(body.authEntry, "Signed authorization", 20_000);
    const receipt = await this.chain.submitPayment(paymentId, this.classicWallet(account), signed);
    const payment = this.record({ ownerId: account.ownerId, actorId: agent.id, accountId: account.id, source: this.chain.wallet(account.id).address, destination: pending.seller, kind: "payment", amount: pending.amount, currency: "USD", mandateId: mandate.id, agentId: agent.id, reference: pending.reference, requestId: paymentId }, receipt);
    return { status: "paid", payment };
  }
  /** The agent paid a store itself over x402. Mandate records it only after reading the transfer from chain. */
  async recordX402(agent: AgentRecord, body: Record<string, unknown>): Promise<AgentPaymentOutcome> {
    const mandate = this.agentMandate(agent, body.mandate);
    const txHash = text(body.txHash, "Transaction hash", 64).toLowerCase();
    const url = text(body.url, "Store URL", 500);
    let host: string;
    try { host = new URL(url).host; } catch { throw new ServiceError(400, "Enter the store URL the agent bought from"); }
    const reference = text(body.reference, "Payment reference", 200);
    const existing = this.core.read().entries.find(entry => entry.id === txHash);
    if (existing) {
      requireThat(existing.agentId === agent.id, 409, "That payment is already recorded");
      return { status: "paid", payment: publicEntry(existing) };
    }
    const transfer = await this.chain.readTransfer(txHash);
    const account = this.core.read().accounts.find(saved => saved.id === mandate.accountId)!;
    requireThat(transfer.from === this.chain.wallet(account.id).address, 403, "That payment did not come from this mandate's account");
    requireThat(transfer.token === this.chain.usdToken(), 403, "That payment was not in USD");
    requireThat(transfer.amount > 0n && await this.chain.isVerifiedSmartAccount(transfer.to), 403, "That payment did not go to a verified seller");
    const payment = this.record({ ownerId: account.ownerId, actorId: agent.id, accountId: account.id, source: transfer.from, destination: transfer.to, kind: "payment", amount: decimal(transfer.amount), currency: "USD", mandateId: mandate.id, agentId: agent.id, reference: `${reference} · x402 ${host}`, requestId: `x402:${txHash}` }, { txHash });
    return { status: "paid", payment };
  }
}
