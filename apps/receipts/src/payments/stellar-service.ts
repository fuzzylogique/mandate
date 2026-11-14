import { createHash, randomBytes } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";
import { formatAmount, toBaseUnits } from "@mandate/shared";
import type { AccountMandate, AccountOpening, MandatePaymentPreview, PaymentEntry, PaymentWorkspace, SpendingAccount } from "@mandate/shared";
import { WorkspaceStore, ServiceError, amount, mandateSpent, requireThat, text, validateMandateInput, type Actor, type EntryRecord, type MandateRecord, type StellarAccountPair, publicEntry } from "./store.ts";
import type { ChainGateway, ChainReceipt } from "./stellar.ts";
import { TraditionalBankingDemo, bankingAmount } from "./traditional.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const timestamp = () => new Date().toISOString();
const decimal = (value: bigint) => formatAmount(value.toString());


/** Auth and account ownership stay local; money and smart-account rules live on Stellar. */
export class StellarPaymentService {
  readonly network;
  private core: WorkspaceStore;
  private chain: ChainGateway;
  private bank: TraditionalBankingDemo;
  constructor(path: string, chain: ChainGateway) {
    this.core = new WorkspaceStore(path);
    this.chain = chain;
    this.network = chain.network;
    this.bank = new TraditionalBankingDemo(this.core);
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
    if (account.rail === "traditional") return { ...account, type: "traditional", verificationSource: "demo" };
    const wallet = this.chain.wallet(account.id);
    return { ...account, type: "stellar", currency: this.network.currency, address: wallet.address, network: this.network.id, explorerUrl: `${this.network.explorerUrl}/${account.rail === "blockchain" ? "contract" : "account"}/${wallet.address}` };
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
    const view = this.core.workspace(actor);
    const accounts = new Map<string, SpendingAccount>();
    for (const account of [...view.accounts, ...view.shared.map(s => s.account)]) accounts.set(account.id, account);
    await Promise.all([...accounts.values()].map(async account => {
      if (account.rail === "traditional") { accounts.set(account.id, this.decorate(account)); return; }
      const [balance, verified] = await Promise.all([this.chain.balance(this.chain.wallet(account.id)), account.rail === "blockchain" ? this.chain.isVerifiedSmartAccount(this.chain.wallet(account.id).address) : false]);
      accounts.set(account.id, { ...this.decorate(account), balance: decimal(balance), verified, verificationSource: account.rail === "blockchain" ? "on-chain" : undefined });
    }));
    const mandates = new Map<string, AccountMandate>();
    for (const mandate of [...view.mandates, ...view.shared.map(s => s.mandate)]) mandates.set(mandate.reference, mandate);
    await Promise.all([...mandates.values()].map(async mandate => {
      const source = accounts.get(mandate.accountId);
      mandate.rail = source?.rail === "traditional" ? "traditional" : "blockchain";
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
    const type = body.type;
    requireThat(type === "traditional" || type === "stellar", 400, "Choose Traditional account or Stellar account");
    requireThat(!body.parentId && !body.classicAccountId, 400, "Account setup is managed automatically");
    if (type === "traditional") {
      requireThat(!body.rail || body.rail === "traditional", 400, "The account type and payment method do not match");
      return this.bank.open(actor, body);
    }
    requireThat(!body.rail || body.rail === "blockchain", 400, "The account type and payment method do not match");
    return this.openStellar(actor, name, text(body.requestId, "Idempotency key", 100));
  }
  private async openStellar(actor: Actor, name: string, requestId: string): Promise<SpendingAccount> {
    requireThat(this.network.verifiedSmartAccounts, 503, "Stellar accounts are not configured");
    const commandId = this.commandId(actor, "stellar-opening", requestId);
    return this.chain.command(commandId, { name }, async () => {
      const id = `STELLAR_${digest(commandId).slice(0, 32)}`;
      const classic = this.chain.treasury(`classic:${id}`);
      await this.chain.faucet(classic);
      const created = await this.chain.createAccount(id, classic);
      const verification = await this.chain.verifySmartAccount(id, created, classic);
      const account: SpendingAccount = { id, ownerId: actor.id, name, rail: "blockchain", type: "stellar", verified: true, verificationTxHash: verification.txHash, currency: this.network.currency, balance: "0", address: created.address, network: this.network.id, creationTxHash: created.txHash, createdAt: timestamp() };
      this.core.update(state => {
        const pairs = state.stellarPairs;
        if (!pairs.some(p => p.accountId === id)) pairs.push({ accountId: id, classicWalletId: classic.id });
        this.assertPairs(pairs);
        if (!state.accounts.some(a => a.id === id)) state.accounts.push(account);
      });
      return { ...this.decorate(account), balance: decimal(await this.chain.balance(created)) };
    });
  }
  async openAccount(actor: Actor, body: Record<string, unknown>): Promise<AccountOpening> {
    requireThat(body.type === "traditional" || body.type === "stellar", 400, "Choose Traditional account or Stellar account");
    return { account: await this.createAccount(actor, body) };
  }
  async fund(actor: Actor, id: string, body: Record<string, unknown>) {
    const target = this.owned(actor, id);
    if (target.rail === "traditional") return this.bank.fund(actor, id, body);
    requireThat(target.rail === "blockchain", 400, "Choose a Stellar account");
    requireThat(!body.sourceAccountId && !body.classicAccountId, 400, "Funding is managed automatically");
    const units = amount(body.amount);
    const commandId = this.commandId(actor, "add-funds", body.requestId);
    return this.chain.command(commandId, { accountId: id, amount: decimal(units) }, async () => {
      const pair = this.pair(target);
      const source = this.chain.treasury(pair.classicWalletId);
      // Each step has its own persisted transaction ID. On a failed second step,
      // repeat the same request to recover the deposit and resume the transfer.
      if (!this.chain.hasTransaction(commandId)) {
        if (await this.chain.balance(source) === 0n) await this.chain.faucet(source);
      }
      await this.chain.deposit(commandId, source, units);
      const destination = this.chain.wallet(id);
      const receipt = await this.chain.transfer(commandId, source, source, destination.address, units);
      return this.record({ ownerId: actor.id, actorId: actor.id, accountId: id, source: "Added funds", destination: destination.address, kind: "funding", amount: decimal(units), currency: this.network.currency, mandateId: null, reference: "Account funding", requestId: String(body.requestId) }, receipt);
    });
  }
  async createMandate(actor: Actor, body: Record<string, unknown>) {
    const account = this.owned(actor, body.accountId);
    const traditional = account.rail === "traditional";
    requireThat(traditional || account.rail === "blockchain", 400, "Choose a traditional demo account or verified Smart Account for the mandate");
    requireThat(!body.rail || body.rail === account.rail, 400, "Choose a source account matching the mandate's payment method");
    if (!traditional) requireThat(this.network.mandates, 503, "Run pnpm setup:contracts to configure verified-smart mandate payments");
    const commandId = this.commandId(actor, "mandate", body.requestId);
    const validated = validateMandateInput(body);
    if (traditional) bankingAmount(body.limit);
    const id = digest(commandId).slice(0, 32);
    const details = { accountId: account.id, name: validated.name, recipient: validated.recipient, recipientType: validated.recipientType, limit: validated.limit, period: validated.period, expiresAt: validated.expiresAt };
    await this.chain.command(commandId, details, async () => {
      let ruleId: number | undefined;
      if (account.rail === "blockchain") {
        const created = await this.chain.addMandate(id, this.classicWallet(account), this.chain.wallet(account.id), { name: validated.name, limit: BigInt(toBaseUnits(validated.limit)), period: validated.period!, expiresAt: validated.expiresAt });
        ruleId = created.ruleId;
      }
      const mandateId = this.chain.secret(`token:${id}`, () => `mnd_${randomBytes(32).toString("base64url")}`);
      const mandate: MandateRecord = { ...validated, id, accountId: account.id, ruleId, rail: traditional ? "traditional" : "blockchain", spent: "0", status: "active", createdAt: timestamp(), enforcement: traditional ? "service" : "on-chain", verifiedRecipientsOnly: true, mandateIdHash: digest(mandateId) };
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
      if (account.rail === "blockchain" && mandate.ruleId !== undefined) {
        this.core.update(state => { state.mandates.find(m => m.id === id)!.chainRevocationPending = true; });
        await this.chain.revokeMandate(id, this.classicWallet(account), this.chain.wallet(account.id), mandate.ruleId);
        this.core.update(state => { state.mandates.find(m => m.id === id)!.chainRevocationPending = false; });
      }
      return { revoked: true };
    });
  }
  async pay(actor: Actor, body: Record<string, unknown>): Promise<PaymentEntry> {
    const selected = this.core.read().accounts.find(a => a.id === body.accountId);
    if (selected?.rail === "traditional") return this.bank.pay(actor, body);
    const units = amount(body.amount);
    const destination = text(body.destination, "Stellar recipient address", 56);
    const reference = text(body.reference, "Payment reference", 200);
    const commandId = this.commandId(actor, "payment", body.requestId);
    return this.chain.command(commandId, { accountId: body.accountId, mandateId: body.mandateReference ?? null, destination, amount: decimal(units), reference }, async () => {
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
      requireThat(account.rail === "blockchain", 400, "Payments must be sent from a Smart Account to a Smart Account");
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
        requireThat(await this.chain.balance(this.chain.wallet(account.id)) >= units, 409, "Insufficient account balance");
      }
      const treasury = this.classicWallet(account);
      const source = this.chain.wallet(account.id);
      const receipt = await this.chain.transfer(commandId, treasury, source, destination, units, mandate?.ruleId !== undefined ? { id: mandate.id, ruleId: mandate.ruleId } : undefined);
      return this.record({ ownerId: account.ownerId, actorId: actor.id, accountId: account.id, source: source.address, destination, kind: "payment", amount: decimal(units), currency: this.network.currency, mandateId: mandate?.id ?? null, reference, requestId: String(body.requestId) }, receipt);
    });
  }
  private paymentMandate(value: unknown) {
    const actor = this.core.authenticateMandate(value);
    requireThat(actor.kind === "mandate", 401, "Enter a valid secret mandate ID");
    const mandate = this.core.read().mandates.find(m => m.id === actor.mandateReference)!;
    const traditional = this.core.read().accounts.find(a => a.id === mandate.accountId)?.rail === "traditional";
    requireThat(mandate.verifiedRecipientsOnly && (traditional || mandate.ruleId !== undefined), 403, "A verified-recipient payment mandate is required");
    return { actor, mandate };
  }
  async previewMandatePayment(body: Record<string, unknown>): Promise<MandatePaymentPreview> {
    const { mandate } = this.paymentMandate(body.mandateId);
    const state = this.core.read();
    const source = state.accounts.find(a => a.id === mandate.accountId)!;
    requireThat(!body.rail || body.rail === source.rail, 400, "The selected payment method does not match this mandate");
    if (source.rail === "traditional") {
      const units = bankingAmount(body.amount);
      const identifier = text(body.sellerAddress, "Traditional recipient reference", 128);
      const seller = this.bank.verifiedRecipient(state, identifier);
      const spent = mandateSpent(state, mandate);
      return {
        rail: "traditional", mandate: { name: mandate.name, address: source.address!, limit: mandate.limit, spent: decimal(spent), expiresAt: mandate.expiresAt },
        seller: { address: identifier, name: text(body.sellerName || "Recipient", "Recipient name"), verified: !!seller }, currency: "USD", balance: source.balance,
        checks: [
          { label: "Mandate is active and has not expired", passed: mandate.status === "active" && mandate.expiresAt > timestamp() },
          { label: "Recipient is a verified traditional demo account", passed: !!seller },
          { label: "Recipient is different from the source account", passed: !!seller && seller.id !== source.id },
          { label: "Payment is within the remaining spending limit", passed: spent + units <= BigInt(toBaseUnits(mandate.limit)) },
          { label: "Source account has sufficient demo funds", passed: BigInt(toBaseUnits(source.balance)) >= units },
        ],
      };
    }
    const sellerAddress = text(body.sellerAddress, "Seller smart-account address", 56);
    const sellerName = text(body.sellerName || "Seller", "Seller name");
    const units = amount(body.amount);
    const wallet = this.chain.wallet(mandate.accountId);
    const [verified, balance, spent] = await Promise.all([
      this.chain.isVerifiedSmartAccount(sellerAddress), this.chain.balance(wallet), this.chain.spent(wallet, mandate.ruleId!),
    ]);
    return {
      rail: "blockchain",
      mandate: { name: mandate.name, address: wallet.address, limit: mandate.limit, spent: decimal(spent), expiresAt: mandate.expiresAt },
      seller: { address: sellerAddress, name: sellerName, verified }, currency: this.network.currency, balance: decimal(balance),
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
    const source = this.core.read().accounts.find(a => a.id === mandate.accountId)!;
    requireThat(!body.rail || body.rail === source.rail, 400, "The selected payment method does not match this mandate");
    return this.pay(actor, { accountId: mandate.accountId, mandateReference: mandate.id, amount: body.amount, destination: body.sellerAddress, reference: body.reference, requestId: body.requestId });
  }
}
