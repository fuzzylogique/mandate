import { createHash, randomBytes } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";
import { formatAmount, toBaseUnits } from "@mandate/shared";
import type { AccountMandate, AccountOpening, FundingMethod, MandatePaymentPreview, PaymentEntry, PaymentWorkspace, SpendingAccount } from "@mandate/shared";
import { WorkspaceStore, ServiceError, amount, requireThat, text, validateMandateInput, type Actor, type EntryRecord, type MandateRecord, type StellarAccountPair, publicEntry } from "./store.ts";
import type { ChainGateway, ChainReceipt } from "./stellar.ts";
import { fundingAmount } from "./funding.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const timestamp = () => new Date().toISOString();
const decimal = (value: bigint) => formatAmount(value.toString());


/** Auth and account ownership stay local; money and smart-account rules live on Stellar. */
export class StellarPaymentService {
  readonly network;
  private core: WorkspaceStore;
  private chain: ChainGateway;
  constructor(path: string, chain: ChainGateway) {
    this.core = new WorkspaceStore(path);
    this.chain = chain;
    const usd = chain.network.assets?.find(asset => asset.currency === "USD");
    this.network = { ...chain.network, currency: "USD", tokenContract: usd?.tokenContract ?? chain.network.tokenContract, assets: usd ? [usd] : undefined };
  }
  close() { this.core.close(); this.chain.close(); }
  register(body: Record<string, unknown>) { return this.core.register(body); }
  login(body: Record<string, unknown>) { return this.core.login(body); }
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
    return { ...details, currency: "USD", address: wallet.address, network: this.network.id, explorerUrl: `${this.network.explorerUrl}/contract/${wallet.address}` };
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
    // Upgrade old local demo accounts without exposing the custody layers.
    const initial = this.core.workspace(actor);
    for (const account of [...initial.accounts, ...initial.shared.map(shared => shared.account)]) {
      if (!account.address || !StrKey.isValidContract(account.address) || this.upgradePending(account.id)) await this.upgradeTraditional(account);
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
      accounts: view.accounts.map(a => accounts.get(a.id)!),

      mandates: view.mandates.map(m => mandates.get(m.reference)!),
      shared: view.shared.map(s => ({ ...s, account: accounts.get(s.account.id)!, mandate: mandates.get(s.mandate.reference)! })),
    };
  }
  async createAccount(actor: Actor, body: Record<string, unknown>): Promise<SpendingAccount> {
    this.customer(actor);
    const name = text(body.name, "Account name");
    const type = body.type ?? "stellar";
    requireThat(type === "traditional" || type === "stellar", 400, "Invalid account type");
    requireThat(!body.parentId && !body.classicAccountId, 400, "Account setup is managed automatically");
    requireThat(!body.rail || body.rail === (type === "traditional" ? "traditional" : "blockchain"), 400, "The account type and payment method do not match");
    const requestId = text(body.requestId, "Idempotency key", 100);
    const commandId = this.commandId(actor, `${type}-opening`, requestId);
    const created = await this.chain.command(commandId, { name }, async () => {
      const id = `${type === "traditional" ? "BANK" : "STELLAR"}_${digest(commandId).slice(0, 32)}`;
      return this.provisionAccount({ id, ownerId: actor.id, name, type, rail: type === "traditional" ? "traditional" : "blockchain", currency: "USD", balance: "0", createdAt: timestamp() });
    });
    return { ...this.decorate(created), balance: decimal(await this.chain.balance(this.chain.wallet(created.id), "USD")) };
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
      else state.accounts[index] = provisioned;
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
    const method = body.method ?? "fiat";
    requireThat(method === "fiat" || method === "testnet", 400, "Choose FIAT or Testnet funding");
    let target = this.owned(actor, id);
    if (!target.address || !StrKey.isValidContract(target.address) || this.upgradePending(target.id)) { await this.upgradeTraditional(target); target = this.owned(actor, id); }
    requireThat(!body.sourceAccountId && !body.classicAccountId, 400, "Funding is managed automatically");
    const units = fundingAmount(body.amount);
    const commandId = this.commandId(actor, "add-funds", body.requestId);
    // Keep existing FIAT retries compatible with requests made before method selection.
    return this.chain.command(commandId, { accountId: id, amount: decimal(units), ...(method === "testnet" ? { method } : {}) }, () => this.fundAccount(actor, target, units, commandId, method === "testnet" ? "Testnet funding" : "Account funding", method));
  }
  private async fundAccount(actor: Actor, target: SpendingAccount, units: bigint, commandId: string, reference = "Account funding", method: FundingMethod = "fiat") {
    const currency = "USD";
    const source = this.chain.treasury(this.pair(target).classicWalletId);
    if (!this.chain.hasTransaction(commandId) && await this.chain.balance(source) === 0n) await this.chain.faucet(source);
    await this.chain.deposit(commandId, source, units, currency);
    const destination = this.chain.wallet(target.id);
    const receipt = await this.chain.transfer(commandId, source, source, destination.address, units, undefined, currency);
    return this.record({ ownerId: target.ownerId, actorId: actor.id, accountId: target.id, source: method === "fiat" ? "Demo USD deposit" : "Stellar testnet funding", destination: destination.address, kind: "funding", amount: decimal(units), currency, mandateId: null, reference, requestId: commandId }, receipt);
  }
  async createMandate(actor: Actor, body: Record<string, unknown>) {
    const account = this.owned(actor, body.accountId);
    requireThat(account.address && StrKey.isValidContract(account.address), 409, "Open the Accounts dashboard to finish upgrading this account");
    requireThat(this.network.mandates, 503, "Run pnpm setup:contracts to configure verified-smart mandate payments");
    const commandId = this.commandId(actor, "mandate", body.requestId);
    const validated = validateMandateInput(body);
    const currency = this.currency(body.currency);
    const id = digest(commandId).slice(0, 32);
    const details = { accountId: account.id, currency, name: validated.name, recipient: validated.recipient, recipientType: validated.recipientType, limit: validated.limit, period: validated.period, expiresAt: validated.expiresAt };
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
    return this.chain.command(commandId, { accountId: body.accountId, mandateId: body.mandateReference ?? null, destination, amount: decimal(units), reference, currency: body.currency ?? null }, async () => {
      const state = this.core.read();
      const account = state.accounts.find(a => a.id === body.accountId);
      requireThat(account, 404, "Account not found");
      let mandate: MandateRecord | undefined;
      if (actor.kind === "mandate" || actor.id !== account.ownerId || body.mandateReference) {
        mandate = state.mandates.find(m => m.id === (actor.kind === "mandate" ? actor.mandateReference : body.mandateReference) && m.accountId === account.id);
        const customer = actor.kind === "customer" ? this.customer(actor) : undefined;
        requireThat(mandate && (actor.kind === "mandate" || actor.id === account.ownerId || (mandate.recipientType === "person" && mandate.recipient === customer?.email)), 403, "You do not have a mandate for this account");
        requireThat(mandate.status === "active" && mandate.expiresAt > timestamp(), 403, "This mandate has expired or been revoked");
      }
      requireThat(account.address && StrKey.isValidContract(account.address), 409, "Open the Accounts dashboard to finish upgrading this account");
      const currency = this.currency(mandate ? mandate.currency ?? account.currency : body.currency);
      requireThat(!mandate || !body.currency || body.currency === currency, 400, "The payment currency does not match this mandate");
      const recovering = this.chain.hasTransaction(commandId);
      if (mandate) {
        requireThat(mandate.ruleId !== undefined, 409, "The mandate payment rule is missing");
        requireThat(mandate.status === "active" && mandate.expiresAt > timestamp(), 403, "This mandate has expired or been revoked");
        if (!recovering) {
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
      const receipt = await this.chain.transfer(commandId, treasury, source, destination, units, mandate?.ruleId !== undefined ? { id: mandate.id, ruleId: mandate.ruleId } : undefined, currency);
      return this.record({ ownerId: account.ownerId, actorId: actor.id, accountId: account.id, source: source.address, destination, kind: "payment", amount: decimal(units), currency, mandateId: mandate?.id ?? null, reference, requestId: String(body.requestId) }, receipt);
    });
  }
  private currency(value: unknown): string {
    const currency = value ?? "USD";
    requireThat(currency === "USD", 400, "Payments and mandates use USD. Create a new USD mandate to replace an older XLM mandate.");
    return currency;
  }
  private paymentMandate(value: unknown) {
    const actor = this.core.authenticateMandate(value);
    requireThat(actor.kind === "mandate", 401, "Enter a valid secret mandate ID");
    const mandate = this.core.read().mandates.find(m => m.id === actor.mandateReference)!;
    requireThat(mandate.verifiedRecipientsOnly && mandate.ruleId !== undefined, 403, "A verified-recipient payment mandate is required");
    return { actor, mandate };
  }
  async previewMandatePayment(body: Record<string, unknown>): Promise<MandatePaymentPreview> {
    const { mandate } = this.paymentMandate(body.mandateId);
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
      mandate: { name: mandate.name, address: wallet.address, limit: mandate.limit, spent: decimal(spent), expiresAt: mandate.expiresAt },
      seller: { address: sellerAddress, name: sellerName, verified }, currency, balance: decimal(balance),
      checks: [
        { label: "Mandate is active and has not expired", passed: mandate.status === "active" && mandate.expiresAt > timestamp() },
        { label: "Seller is a verified smart account", passed: verified },
        { label: "Recipient is different from the source account", passed: sellerAddress !== wallet.address },
        { label: "Payment is within the remaining spending limit", passed: spent + units <= BigInt(toBaseUnits(mandate.limit)) },
        { label: "Mandate account has sufficient funds", passed: balance >= units },
      ],
    };
  }
  async payWithMandate(body: Record<string, unknown>): Promise<PaymentEntry> {
    const { actor, mandate } = this.paymentMandate(body.mandateId);
    return this.pay(actor, { accountId: mandate.accountId, mandateReference: mandate.id, amount: body.amount, destination: body.sellerAddress, reference: body.reference, requestId: body.requestId });
  }
}
