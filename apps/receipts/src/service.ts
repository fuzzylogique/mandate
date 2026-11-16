// Mandate: everything an account owner, a person they share with, and a
// shopper (hosted or an outside assistant) can do.
//
// Who enforces what:
// - On-chain, per shopper: its own key on its own rule, a spending limit per
//   rolling window, trusted stores only (seller registry), an expiry ledger.
// - Here: sign-in, which customer owns which account, what was bought, and
//   the owner's decisions on blocked purchases.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { formatAmount, toBaseUnits } from "@mandate/shared";
import type { SpendingAccount } from "@mandate/shared";
import { createPayingFetch, settlementTxHash } from "@mandate/agent/purchase";
import {
  agentSigningPayload,
  type Account,
  type Activity,
  type AgentBudget,
  type AgentConnection,
  type AgentReport,
  type ApprovalDecision,
  type ApprovalRequest,
  type Customer,
  type Offer,
  type Overview,
  type Period,
  type PurchaseOutcome,
  type SharedSpending,
  type Shopper,
  type ShopperKind,
  type Store,
} from "@mandate/shared/api";
import { OWNER_RULE, type ChainGateway, type ChainWallet } from "./payments/stellar.ts";
import {
  ServiceError,
  WorkspaceStore,
  amount,
  requireThat,
  text,
  type Actor,
  type MandateRecord,
  type RequestRecord,
  type State,
} from "./payments/store.ts";
import { fundingAmount } from "./payments/funding.ts";
import type { ReceiptStore } from "./store.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const dollars = (units: bigint) => formatAmount(units.toString());
const units = (value: string) => BigInt(toBaseUnits(value));
const PERIOD_MS: Record<Period, number> = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 };
const PERIOD_WORD: Record<Period, string> = { day: "day", week: "week", month: "month" };
const PAIRING_MINUTES = 30;
const CATALOG_TTL_MS = 15_000;
const TRUST_TTL_MS = 30_000;
const SPENT_TTL_MS = 4_000;

export interface ServiceOptions {
  merchantUrl: string;
  verifier: string;
  rpcUrl: string;
  explorerUrl: string;
  receipts: ReceiptStore;
}

interface CatalogStore {
  slug: string; name: string; domain: string; payTo: string; looksLike?: string;
  items: { id: string; title: string; price: string; url: string }[];
}

/** Money shown to people: "$2.40". */
const money = (value: string | bigint) => {
  const n = Number(typeof value === "bigint" ? dollars(value) : value);
  return `$${n.toFixed(2)}`;
};

export class MandateService {
  private core: WorkspaceStore;
  private chain: ChainGateway;
  private options: ServiceOptions;
  private catalogCache?: { at: number; stores: CatalogStore[] };
  private trustCache = new Map<string, { at: number; value: boolean }>();
  private spentCache = new Map<string, { at: number; value: bigint }>();
  private balanceCache = new Map<string, bigint>();
  private running = new Set<string>();
  private usd?: { tokenContract: string; issuer: string };

  constructor(path: string, chain: ChainGateway, options: ServiceOptions) {
    this.core = new WorkspaceStore(path);
    this.chain = chain;
    this.options = options;
  }

  close() { this.core.close(); this.chain.close(); }

  // ---------- sign-in ----------

  register(body: Record<string, unknown>) { return this.core.register(body); }
  login(body: Record<string, unknown>) { return this.core.login(body); }
  authenticate(token: string) { return this.core.authenticate(token); }
  logout(token: string) { return this.core.logout(token); }

  private customer(actor: Actor, state = this.core.read()) {
    const found = actor.kind === "customer" ? state.customers.find((c) => c.id === actor.id) : undefined;
    requireThat(found, 401, "Please sign in");
    return found;
  }
  me(actor: Actor): Customer {
    const { id, name, email } = this.customer(actor);
    return { id, name, email };
  }

  // ---------- the account ----------

  private accountOf(ownerId: string, state = this.core.read()): SpendingAccount | undefined {
    return state.accounts.find((account) => account.ownerId === ownerId && account.address);
  }
  private requireAccount(ownerId: string, state = this.core.read()): SpendingAccount {
    const account = this.accountOf(ownerId, state);
    requireThat(account, 409, "Open your account first");
    return account;
  }
  private treasury(account: SpendingAccount): ChainWallet {
    const pair = this.core.read().stellarPairs.find((p) => p.accountId === account.id);
    requireThat(pair, 409, "Account setup is incomplete. Try opening it again.");
    return this.chain.treasury(pair.classicWalletId);
  }
  private async token(): Promise<string> {
    this.usd ??= await this.chain.ensureUsd();
    return this.usd.tokenContract;
  }

  private async accountView(account: SpendingAccount | undefined): Promise<Account> {
    if (!account?.address) return { status: "none", balance: "0", currency: "USD" };
    // A failed read keeps the last balance we saw, so the apps don't flash $0.
    let balance: bigint;
    try {
      balance = await this.chain.balance(this.chain.wallet(account.id), "USD");
      this.balanceCache.set(account.id, balance);
    } catch {
      balance = this.balanceCache.get(account.id) ?? 0n;
    }
    return {
      status: "ready",
      address: account.address,
      balance: dollars(balance),
      currency: "USD",
      explorerUrl: `${this.options.explorerUrl}/contract/${account.address}`,
    };
  }

  /** Opens the customer's one account: a smart account they own, on Stellar testnet. */
  async openAccount(actor: Actor): Promise<Account> {
    const customer = this.customer(actor);
    const existing = this.accountOf(customer.id);
    if (existing) return this.accountView(existing);
    requireThat(this.chain.network.smartAccounts, 503, "Smart accounts are not configured. Run pnpm setup.");
    const commandId = `${customer.id}:open-account`;
    await this.chain.command(commandId, { customer: customer.id }, async () => {
      const id = `ACCT_${digest(commandId).slice(0, 32)}`;
      // A hidden classic key owns the account and pays network fees.
      const classic = this.chain.treasury(`classic:${id}`);
      if ((await this.chain.balance(classic)) === 0n) await this.chain.faucet(classic);
      const created = await this.chain.createAccount(id, classic);
      this.core.update((state) => {
        if (!state.stellarPairs.some((pair) => pair.accountId === id)) state.stellarPairs.push({ accountId: id, classicWalletId: classic.id });
        if (!state.accounts.some((account) => account.id === id)) {
          state.accounts.push({
            id, ownerId: customer.id, name: `${customer.name}'s account`, rail: "blockchain", type: "stellar",
            currency: "USD", balance: "0", createdAt: now(), address: created.address,
            network: this.chain.network.id, creationTxHash: created.txHash,
          });
        }
      });
      return { id };
    });
    return this.accountView(this.accountOf(customer.id));
  }

  /** Adds demo dollars: a stand-in for a bank transfer or card top-up. */
  async addMoney(actor: Actor, body: Record<string, unknown>): Promise<Account> {
    const customer = this.customer(actor);
    const account = this.requireAccount(customer.id);
    const value = fundingAmount(body.amount);
    const commandId = `${customer.id}:add-money:${text(body.requestId, "Request ID", 128)}`;
    await this.chain.command(commandId, { amount: dollars(value) }, async () => {
      const source = this.treasury(account);
      if (!this.chain.hasTransaction(commandId) && (await this.chain.balance(source)) === 0n) await this.chain.faucet(source);
      await this.chain.deposit(commandId, source, value, "USD");
      const receipt = await this.chain.transfer(commandId, source, source, account.address!, value, undefined, "USD");
      this.core.update((state) => {
        if (state.entries.some((entry) => entry.id === receipt.txHash)) return;
        state.entries.push({
          id: receipt.txHash, ownerId: customer.id, actorId: customer.id, accountId: account.id,
          source: "Demo bank transfer", destination: account.address!, kind: "funding", amount: dollars(value),
          currency: "USD", mandateId: null, reference: "Added money", createdAt: now(), settlement: "stellar-testnet",
          txHash: receipt.txHash, explorerUrl: `${this.options.explorerUrl}/tx/${receipt.txHash}`, requestId: commandId,
        });
      });
      return { txHash: receipt.txHash };
    });
    return this.accountView(account);
  }

  // ---------- stores ----------

  private async catalog(): Promise<CatalogStore[]> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < CATALOG_TTL_MS) return this.catalogCache.stores;
    try {
      const response = await fetch(`${this.options.merchantUrl}/catalog`, { signal: AbortSignal.timeout(5_000) });
      const body = (await response.json()) as { stores: CatalogStore[] };
      this.catalogCache = { at: Date.now(), stores: body.stores };
    } catch {
      this.catalogCache = { at: Date.now(), stores: this.catalogCache?.stores ?? [] };
    }
    return this.catalogCache.stores;
  }

  private async trusted(address: string): Promise<boolean> {
    const cached = this.trustCache.get(address);
    if (cached && Date.now() - cached.at < TRUST_TTL_MS) return cached.value;
    const value = await this.chain.isTrusted(address).catch(() => cached?.value ?? false);
    this.trustCache.set(address, { at: Date.now(), value });
    return value;
  }

  async stores(): Promise<Store[]> {
    return Promise.all((await this.catalog()).map(async (store) => ({
      address: store.payTo, name: store.name, domain: store.domain,
      trusted: await this.trusted(store.payTo),
      ...(store.looksLike ? { looksLike: store.looksLike } : {}),
    })));
  }

  private async storeFor(address: string): Promise<Store> {
    const found = (await this.stores()).find((store) => store.address === address);
    return found ?? { address, name: `${address.slice(0, 4)}…${address.slice(-4)}`, domain: "", trusted: await this.trusted(address) };
  }

  /** Every listing, optionally filtered by words in the title. Cheapest first. */
  async offers(query?: string): Promise<Offer[]> {
    const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const stores = await this.stores();
    const offers: Offer[] = [];
    for (const store of await this.catalog()) {
      const view = stores.find((s) => s.address === store.payTo)!;
      for (const item of store.items) {
        const title = item.title.toLowerCase();
        if (words.length && !words.every((word) => title.includes(word) || item.id.includes(word))) continue;
        offers.push({ id: `${store.slug}/${item.id}`, title: item.title, price: item.price, store: view, url: item.url });
      }
    }
    return offers.sort((a, b) => Number(a.price) - Number(b.price));
  }

  private async offer(id: unknown): Promise<Offer> {
    const found = (await this.offers()).find((offer) => offer.id === id);
    requireThat(found, 404, "That item is not for sale anywhere we know");
    return found;
  }

  // ---------- shoppers ----------

  private async spent(mandate: MandateRecord): Promise<bigint> {
    if (mandate.ruleId === undefined || mandate.status === "revoked") return 0n;
    const cached = this.spentCache.get(mandate.id);
    if (cached && Date.now() - cached.at < SPENT_TTL_MS) return cached.value;
    const value = await this.chain.spent(this.chain.wallet(mandate.accountId), mandate.ruleId).catch(() => cached?.value ?? 0n);
    this.spentCache.set(mandate.id, { at: Date.now(), value });
    return value;
  }

  private status(mandate: MandateRecord): Shopper["status"] {
    if (mandate.status === "revoked") return "stopped";
    if (mandate.expiresAt <= now()) return "expired";
    return mandate.status === "waiting" ? "waiting" : "active";
  }

  private kind(mandate: MandateRecord): ShopperKind {
    return mandate.kind ?? (mandate.recipientType === "person" ? "person" : "hosted");
  }

  private async shopperView(mandate: MandateRecord): Promise<Shopper> {
    const status = this.status(mandate);
    const pairing = status === "waiting" && mandate.pairingExpiresAt
      ? { code: this.chain.secret(`pairing:${mandate.id}:${mandate.pairingVersion ?? 1}`, () => { throw new ServiceError(409, "Pairing code unavailable"); }), expiresAt: mandate.pairingExpiresAt }
      : undefined;
    return {
      id: mandate.id, name: mandate.name, kind: this.kind(mandate), status,
      limit: mandate.limit, spent: dollars(await this.spent(mandate)), period: mandate.period,
      expiresAt: mandate.expiresAt, createdAt: mandate.createdAt,
      ...(mandate.job ? { job: mandate.job } : {}),
      ...(this.kind(mandate) === "person" ? { holder: mandate.recipient } : {}),
      ...(pairing && pairing.expiresAt > now() ? { pairing } : {}),
      ...(mandate.ruleId !== undefined ? { ruleId: mandate.ruleId } : {}),
      ...(mandate.agentKey ? { agentKey: mandate.agentKey } : {}),
      ...(mandate.chainRevocationPending ? { stopPending: true } : {}),
    };
  }

  private owned(actor: Actor, id: unknown, state = this.core.read()): MandateRecord {
    const customer = this.customer(actor, state);
    const mandate = state.mandates.find((m) => m.id === id);
    requireThat(mandate && state.accounts.some((a) => a.id === mandate.accountId && a.ownerId === customer.id), 404, "Shopper not found");
    return mandate;
  }

  async createShopper(actor: Actor, body: Record<string, unknown>): Promise<Shopper> {
    const customer = this.customer(actor);
    const account = this.requireAccount(customer.id);
    requireThat(this.chain.network.mandates, 503, "Shopper rules are not configured. Run pnpm setup.");
    const name = text(body.name, "Name", 40);
    const kind = body.kind;
    requireThat(kind === "hosted" || kind === "assistant" || kind === "person", 400, "Choose who does the shopping");
    const period = body.period;
    requireThat(period === "day" || period === "week" || period === "month", 400, "Choose a period");
    const limit = amount(body.limit);
    const expiresAt = body.expiresAt === undefined ? new Date(Date.now() + 90 * 86_400_000).toISOString() : new Date(String(body.expiresAt)).toISOString();
    requireThat(Date.parse(expiresAt) > Date.now() + 60_000, 400, "Pick an end date in the future");
    let job: MandateRecord["job"];
    if (kind === "hosted") {
      const raw = body.job as { item?: unknown; every?: unknown; startNow?: unknown } | undefined;
      requireThat(raw && typeof raw === "object", 400, "Say what this shopper should keep stocked");
      const every = raw.every ?? period;
      requireThat(every === "day" || every === "week" || every === "month", 400, "Choose how often it shops");
      job = { item: text(raw.item, "Item", 60), every, nextRunAt: raw.startNow === false ? new Date(Date.now() + PERIOD_MS[every]).toISOString() : now() };
    }
    let holder = name;
    if (kind === "person") {
      holder = text(body.holder, "Their email", 254).toLowerCase();
      requireThat(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(holder), 400, "Enter their email address");
      requireThat(holder !== customer.email, 400, "Share with someone else's email");
    }
    const commandId = `${customer.id}:shopper:${text(body.requestId, "Request ID", 128)}`;
    const id = digest(commandId).slice(0, 32);
    const fingerprint = { name, kind, period, limit: dollars(limit), expiresAt: expiresAt.slice(0, 10), job: job?.item ?? null, holder };
    await this.chain.command(commandId, fingerprint, async () => {
      const base: MandateRecord = {
        id, accountId: account.id, name, kind, recipientType: kind === "person" ? "person" : "agent", recipient: holder,
        limit: dollars(limit), spent: "0", period, expiresAt, status: "active", createdAt: now(),
        enforcement: "on-chain", verifiedRecipientsOnly: true, currency: "USD", ...(job ? { job } : {}),
      };
      if (kind === "assistant") {
        // The assistant brings its own key later. Until then there is no rule.
        const code = this.chain.secret(`pairing:${id}:1`, () => pairingCode());
        const record: MandateRecord = { ...base, status: "waiting", pairingVersion: 1, pairingHash: digest(normalizeCode(code)), pairingExpiresAt: new Date(Date.now() + PAIRING_MINUTES * 60_000).toISOString() };
        this.core.update((state) => { if (!state.mandates.some((m) => m.id === id)) state.mandates.push(record); });
        return { id };
      }
      // Hosted shoppers and people: Mandate keeps this shopper's own key in the vault.
      const key = this.chain.keypairFor(`shopper:${id}`);
      const { ruleId } = await this.chain.addMandate(id, this.treasury(account), this.chain.wallet(account.id), {
        name, limit, period, expiresAt, currency: "USD", signer: key.publicKey(),
      });
      this.core.update((state) => { if (!state.mandates.some((m) => m.id === id)) state.mandates.push({ ...base, ruleId, agentKey: key.publicKey() }); });
      return { id };
    });
    const created = this.core.read().mandates.find((m) => m.id === id)!;
    // Give the network a couple of ledgers to show the new rule before the first run.
    if (created.job && created.job.nextRunAt <= now()) setTimeout(() => void this.runDue().catch(() => undefined), 12_000);
    return this.shopperView(created);
  }

  /** A new code for an assistant whose code expired before it connected. */
  async newPairingCode(actor: Actor, id: string): Promise<Shopper> {
    const mandate = this.owned(actor, id);
    requireThat(this.status(mandate) === "waiting", 409, "This shopper is already connected");
    const version = (mandate.pairingVersion ?? 1) + 1;
    const code = this.chain.secret(`pairing:${id}:${version}`, () => pairingCode());
    this.core.update((state) => {
      const found = state.mandates.find((m) => m.id === id)!;
      found.pairingVersion = version;
      found.pairingHash = digest(normalizeCode(code));
      found.pairingExpiresAt = new Date(Date.now() + PAIRING_MINUTES * 60_000).toISOString();
    });
    return this.shopperView(this.core.read().mandates.find((m) => m.id === id)!);
  }

  async stopShopper(actor: Actor, id: string): Promise<void> {
    const mandate = this.owned(actor, id);
    const account = this.requireAccount(this.customer(actor).id);
    await this.chain.command(`${actor.id}:stop:${id}`, { id }, async () => {
      // Block it here at once; removing the rule on-chain stays retryable.
      this.core.update((state) => {
        const found = state.mandates.find((m) => m.id === id)!;
        found.status = "revoked";
        found.chainRevocationPending = found.ruleId !== undefined;
        for (const request of state.requests) if (request.mandateId === id && request.status === "pending") { request.status = "declined"; request.resolvedAt = now(); }
      });
      if (mandate.ruleId !== undefined) {
        await this.chain.revokeMandate(id, this.treasury(account), this.chain.wallet(account.id), mandate.ruleId);
        this.core.update((state) => { state.mandates.find((m) => m.id === id)!.chainRevocationPending = false; });
      }
      return { stopped: true };
    });
  }

  // ---------- buying ----------

  private signerFor(mandate: MandateRecord): Keypair {
    requireThat(this.kind(mandate) !== "assistant", 409, "This shopper holds its own key");
    return this.chain.keypairFor(`shopper:${mandate.id}`);
  }

  /** Pays for `offer` over x402 from the account, signed by `signer` under `ruleId`. */
  private async pay(account: SpendingAccount, offer: Offer, signer: Keypair, ruleId: number): Promise<string | null> {
    const payingFetch = createPayingFetch({
      payer: { mode: "smart-account", agentSecret: signer.secret(), smartAccount: account.address!, contextRuleId: ruleId, verifier: this.options.verifier },
      extraAsset: await this.token(),
    });
    try {
      const response = await payingFetch(offer.url);
      if (!response.ok) console.warn(`[pay] ${offer.id}: store answered ${response.status}`);
      return response.ok ? settlementTxHash(response) ?? null : null;
    } catch (error) {
      // The account refused to authorize the payment, or the store was unreachable.
      console.warn(`[pay] ${offer.id} rule ${ruleId}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
      return null;
    }
  }

  /** Why a purchase was blocked, in words. The network itself only says "not authorized". */
  private async explain(mandate: MandateRecord, offer: Offer): Promise<Pick<ApprovalRequest, "reason" | "kind" | "suggestedLimit">> {
    if (this.status(mandate) !== "active") return { kind: "stopped", reason: `${mandate.name} is ${this.status(mandate) === "expired" ? "past its end date" : "stopped"}` };
    if (!offer.store.trusted) {
      return { kind: "untrusted-store", reason: `${offer.store.name} is not a trusted store${offer.store.looksLike ? `. It looks like ${offer.store.looksLike}` : ""}` };
    }
    const spent = await this.chain.spent(this.chain.wallet(mandate.accountId), mandate.ruleId!).catch(() => 0n);
    const price = units(offer.price);
    if (spent + price > units(mandate.limit)) {
      const needed = spent + price;
      const whole = 10_000_000n;
      const suggested = ((needed + whole - 1n) / whole) * whole;
      return { kind: "over-limit", reason: `Over its ${money(mandate.limit)} a ${PERIOD_WORD[mandate.period]} limit (${money(spent)} spent)`, suggestedLimit: dollars(suggested) };
    }
    const balance = await this.chain.balance(this.chain.wallet(mandate.accountId), "USD").catch(() => 0n);
    if (balance < price) return { kind: "no-money", reason: "Not enough money in your account" };
    return { kind: "over-limit", reason: "Blocked by your account's rules" };
  }

  private recordPaid(mandate: MandateRecord | undefined, ownerId: string, offer: Offer, txHash: string, paidBy: "mandate" | "you", note?: string) {
    this.spentCache.delete(mandate?.id ?? "");
    this.core.update((state) => {
      if (state.notes.some((n) => n.txHash === txHash)) return;
      state.notes.push({ txHash, ownerId, ...(mandate ? { mandateId: mandate.id } : {}), item: offer.title, storeAddress: offer.store.address, amount: offer.price, ...(note ? { note } : {}), paidBy, at: now() });
    });
  }

  /** Records a blocked attempt and asks the owner, reusing an open request for the same thing. */
  private async recordBlocked(mandate: MandateRecord, offer: Offer): Promise<{ reason: string; requestId?: string }> {
    const explanation = await this.explain(mandate, offer);
    const ownerId = this.core.read().accounts.find((a) => a.id === mandate.accountId)!.ownerId;
    return this.core.update((state) => {
      let request = state.requests.find((r) => r.mandateId === mandate.id && r.offerId === offer.id && r.status === "pending");
      const ask = explanation.kind !== "stopped";
      if (!request && ask) {
        request = {
          id: randomBytes(8).toString("hex"), ownerId, mandateId: mandate.id, offerId: offer.id,
          offer: { title: offer.title, price: offer.price, storeAddress: offer.store.address, url: offer.url },
          ...explanation, status: "pending", createdAt: now(),
        };
        state.requests.push(request);
      }
      state.declines.push({
        id: randomBytes(8).toString("hex"), ownerId, mandateId: mandate.id, at: now(), item: offer.title,
        amount: offer.price, storeAddress: offer.store.address, reason: explanation.reason, ...(request ? { requestId: request.id } : {}),
      });
      return { reason: explanation.reason, ...(request ? { requestId: request.id } : {}) };
    });
  }

  /** A shopper whose key Mandate keeps buys `offer`. */
  private async buyAs(mandate: MandateRecord, offer: Offer, note?: string): Promise<PurchaseOutcome> {
    const account = this.core.read().accounts.find((a) => a.id === mandate.accountId)!;
    const txHash = this.status(mandate) === "active" && mandate.ruleId !== undefined ? await this.pay(account, offer, this.signerFor(mandate), mandate.ruleId) : null;
    if (txHash) {
      this.recordPaid(mandate, account.ownerId, offer, txHash, "mandate", note);
      return { status: "paid", txHash, explorerUrl: `${this.options.explorerUrl}/tx/${txHash}`, offer, ...(note ? { note } : {}) };
    }
    const blocked = await this.recordBlocked(mandate, offer);
    return { status: "blocked", offer, ...blocked };
  }

  /** What a hosted shopper does on each run: compare, pick the cheapest trusted store, buy. */
  private async shop(mandate: MandateRecord): Promise<PurchaseOutcome> {
    const item = mandate.job?.item ?? "";
    const offers = await this.offers(item);
    const trusted = offers.filter((offer) => offer.store.trusted);
    if (!trusted.length) return { status: "nothing", reason: offers.length ? `Only untrusted stores sell ${item}` : `No store sells ${item}` };
    const choice = trusted[0]!;
    const skipped = offers.filter((offer) => !offer.store.trusted && Number(offer.price) < Number(choice.price));
    const others = trusted.length > 1 ? `Cheapest of ${trusted.length} trusted stores` : "Only trusted store with it";
    const note = `${others}${skipped.length ? `. Skipped ${skipped.map((o) => `${o.store.name} (${money(o.price)})`).join(", ")}: not trusted` : ""}`;
    return this.buyAs(mandate, choice, note);
  }

  /** Runs every hosted shopper whose next run is due. Called on a timer and after changes. */
  async runDue(): Promise<void> {
    const due = this.core.read().mandates.filter((m) => m.job && this.kind(m) === "hosted" && this.status(m) === "active" && m.job.nextRunAt <= now());
    for (const mandate of due) await this.runJob(mandate.id);
  }

  private async runJob(id: string): Promise<PurchaseOutcome> {
    if (this.running.has(id)) return { status: "nothing", reason: "Already shopping" };
    this.running.add(id);
    try {
      const mandate = this.core.read().mandates.find((m) => m.id === id)!;
      const outcome = await this.shop(mandate);
      const result = outcome.status === "paid"
        ? `Bought ${outcome.offer.title.toLowerCase()} from ${outcome.offer.store.name} for ${money(outcome.offer.price)}`
        : outcome.status === "blocked" ? `Blocked: ${outcome.reason}` : outcome.reason;
      this.core.update((state) => {
        const job = state.mandates.find((m) => m.id === id)!.job!;
        job.lastRunAt = now();
        job.lastResult = result;
        job.nextRunAt = new Date(Date.now() + PERIOD_MS[job.every]).toISOString();
      });
      return outcome;
    } finally {
      this.running.delete(id);
    }
  }

  /**
   * "Shop now" for a hosted shopper, or a test of its rules: try the look-alike
   * store, or something over its limit. Tests attempt the payment for real, so
   * the account's rules are what stops them.
   */
  async runShopper(actor: Actor, id: string, body: Record<string, unknown>): Promise<PurchaseOutcome> {
    const mandate = this.owned(actor, id);
    requireThat(this.kind(mandate) !== "assistant", 409, "An assistant shops from its own app");
    const test = body.test;
    if (test === undefined) {
      requireThat(mandate.job, 409, "This shopper has no job to run");
      return this.runJob(id);
    }
    requireThat(test === "lookalike" || test === "over-limit", 400, "Unknown test");
    const offers = await this.offers();
    const item = mandate.job?.item ?? "";
    const offer = test === "lookalike"
      ? offers.find((o) => !o.store.trusted && o.title.toLowerCase().includes(item.toLowerCase())) ?? offers.find((o) => !o.store.trusted)
      : [...offers].filter((o) => o.store.trusted).sort((a, b) => Number(b.price) - Number(a.price))[0];
    requireThat(offer, 409, test === "lookalike" ? "No look-alike store is running" : "No trusted store is running");
    return this.buyAs(mandate, offer, test === "lookalike" ? "Rules test: a look-alike store" : "Rules test: over the limit");
  }

  // ---------- the owner's decisions ----------

  private async requestView(record: RequestRecord, state: State): Promise<ApprovalRequest> {
    const mandate = state.mandates.find((m) => m.id === record.mandateId);
    const store = await this.storeFor(record.offer.storeAddress);
    const { ownerId: _o, mandateId: _m, offerId, offer, ...rest } = record;
    return {
      ...rest,
      shopper: { id: record.mandateId, name: mandate?.name ?? "A shopper" },
      offer: { id: offerId, title: offer.title, price: offer.price, url: offer.url, store },
    };
  }

  async decide(actor: Actor, id: string, body: Record<string, unknown>): Promise<ApprovalRequest> {
    const customer = this.customer(actor);
    const decision = body.decision as ApprovalDecision;
    requireThat(decision === "allow-once" || decision === "raise-limit" || decision === "decline", 400, "Choose allow once, raise the limit or no");
    const state = this.core.read();
    const record = state.requests.find((r) => r.id === id && r.ownerId === customer.id);
    requireThat(record, 404, "Request not found");
    requireThat(record.status === "pending", 409, "This request was already answered");
    const mandate = state.mandates.find((m) => m.id === record.mandateId)!;
    const account = this.requireAccount(customer.id);
    const settle = (patch: Partial<RequestRecord>) => this.core.update((s) => {
      Object.assign(s.requests.find((r) => r.id === id)!, { resolvedAt: now(), ...patch });
    });

    if (decision === "decline") {
      settle({ status: "declined" });
    } else if (decision === "allow-once") {
      requireThat(record.kind !== "untrusted-store", 409, "Mandate won't pay an untrusted store. Say no, or buy from a trusted one.");
      const offer = await this.offer(record.offerId);
      // You pay this one yourself, under your own key on the account's owner rule.
      const owner = this.chain.keypairFor(this.treasury(account).id);
      const txHash = await this.pay(account, offer, owner, OWNER_RULE);
      if (!txHash) settle({ status: "failed", error: "The payment did not go through. Check your balance and try again." });
      else {
        this.recordPaid(mandate, customer.id, offer, txHash, "you", `You approved this for ${mandate.name}`);
        settle({ status: "allowed", txHash });
      }
    } else {
      requireThat(record.kind === "over-limit" && record.suggestedLimit, 409, "Only a purchase over the limit can be fixed by raising it");
      requireThat(mandate.ruleId !== undefined && this.status(mandate) === "active", 409, "This shopper is stopped");
      const limit = units(record.suggestedLimit);
      await this.chain.setLimit(`${mandate.id}:${record.suggestedLimit}`, this.treasury(account), this.chain.wallet(account.id), mandate.ruleId, limit);
      this.core.update((s) => { s.mandates.find((m) => m.id === mandate.id)!.limit = dollars(limit); });
      this.spentCache.delete(mandate.id);
      if (this.kind(mandate) === "assistant") {
        // Mandate doesn't hold an assistant's key: it buys again itself.
        settle({ status: "raised" });
      } else {
        const outcome = await this.buyAs(this.core.read().mandates.find((m) => m.id === mandate.id)!, await this.offer(record.offerId), "Bought after you raised the limit");
        settle(outcome.status === "paid" ? { status: "raised", txHash: outcome.txHash } : { status: "failed", error: outcome.status === "blocked" ? outcome.reason : "Nothing to buy" });
        if (outcome.status === "paid") {
          // The job's last line said it was blocked; now it isn't.
          this.core.update((s) => {
            const job = s.mandates.find((m) => m.id === mandate.id)!.job;
            if (job) Object.assign(job, { lastRunAt: now(), lastResult: `Bought ${outcome.offer.title.toLowerCase()} from ${outcome.offer.store.name} for ${money(outcome.offer.price)} after you raised the limit` });
          });
        }
      }
    }
    const updated = this.core.read();
    return this.requestView(updated.requests.find((r) => r.id === id)!, updated);
  }

  // ---------- what the owner sees ----------

  async overview(actor: Actor): Promise<Overview> {
    const state = this.core.read();
    const customer = this.customer(actor, state);
    const account = this.accountOf(customer.id, state);
    const mine = state.mandates.filter((m) => m.accountId === account?.id);
    const shared: SharedSpending[] = await Promise.all(
      state.mandates
        .filter((m) => this.kind(m) === "person" && m.recipient === customer.email && m.status !== "revoked")
        .map(async (m) => {
          const owner = state.customers.find((c) => c.id === state.accounts.find((a) => a.id === m.accountId)?.ownerId);
          return { id: m.id, name: m.name, ownerName: owner?.name ?? "Someone", limit: m.limit, spent: dollars(await this.spent(m)), period: m.period, expiresAt: m.expiresAt, status: this.status(m) };
        }),
    );
    return {
      customer: { id: customer.id, name: customer.name, email: customer.email },
      account: await this.accountView(account),
      shoppers: await Promise.all(mine.map((m) => this.shopperView(m))),
      stores: await this.stores(),
      requests: await Promise.all(state.requests.filter((r) => r.ownerId === customer.id && r.status === "pending").map((r) => this.requestView(r, state))),
      shared,
      network: { name: this.chain.network.name, explorerUrl: this.options.explorerUrl },
    };
  }

  async activity(actor: Actor): Promise<Activity[]> {
    const state = this.core.read();
    const customer = this.customer(actor, state);
    const account = this.accountOf(customer.id, state);
    if (!account?.address) return [];
    const byRule = new Map(state.mandates.filter((m) => m.accountId === account.id && m.ruleId !== undefined).map((m) => [m.ruleId!, m]));
    const shopper = (m?: MandateRecord) => (m ? { id: m.id, name: m.name, kind: this.kind(m) } : undefined);
    const tx = (hash: string) => `${this.options.explorerUrl}/tx/${hash}`;
    const items: Activity[] = [];
    const seen = new Set<string>();
    const checks = async (m: MandateRecord | undefined, store: Store) => [
      ...(m ? [`Signed by ${m.name} with its own key, under rule ${m.ruleId}`, `Within its ${money(m.limit)} a ${PERIOD_WORD[m.period]} limit`] : []),
      ...(store.trusted ? [`${store.name} is a trusted store${store.domain ? ` (${store.domain})` : ""}`] : []),
      ...(m ? [`Valid until ${new Date(m.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`] : []),
    ];

    // Payments the chain says passed a shopper's rules.
    for (const receipt of this.options.receipts.list(account.address)) {
      const m = byRule.get(receipt.contextRuleId);
      const note = state.notes.find((n) => n.txHash === receipt.txHash);
      const store = await this.storeFor(receipt.seller);
      seen.add(receipt.txHash);
      items.push({
        id: receipt.id, kind: "paid", at: receipt.paidAt, shopper: shopper(m), store,
        item: note?.item ?? receipt.annotation?.description ?? "Purchase", amount: dollars(BigInt(receipt.amount)),
        ...(note?.note ? { note: note.note } : {}), paidBy: "mandate", txHash: receipt.txHash, explorerUrl: tx(receipt.txHash),
        proof: { smartAccount: account.address, ruleId: receipt.contextRuleId, ...(m?.agentKey ? { agentKey: m.agentKey } : {}), checks: await checks(m, store) },
      });
    }
    // Payments we know about that the indexer hasn't caught up with, and ones you approved yourself.
    for (const note of state.notes.filter((n) => n.ownerId === customer.id && !seen.has(n.txHash))) {
      const m = state.mandates.find((x) => x.id === note.mandateId);
      const store = await this.storeFor(note.storeAddress);
      items.push({
        id: note.txHash, kind: "paid", at: note.at, shopper: shopper(m), store, item: note.item, amount: note.amount,
        ...(note.note ? { note: note.note } : {}), paidBy: note.paidBy, txHash: note.txHash, explorerUrl: tx(note.txHash),
        proof: { smartAccount: account.address, ...(note.paidBy === "you" ? { ruleId: OWNER_RULE } : m ? { ruleId: m.ruleId, agentKey: m.agentKey } : {}), checks: note.paidBy === "you" ? ["Approved by you", "Signed with your own key, under the owner rule"] : await checks(m, store) },
      });
    }
    for (const decline of state.declines.filter((d) => d.ownerId === customer.id)) {
      const m = state.mandates.find((x) => x.id === decline.mandateId);
      items.push({
        id: `blocked-${decline.id}`, kind: "blocked", at: decline.at, shopper: shopper(m), store: await this.storeFor(decline.storeAddress),
        item: decline.item, amount: decline.amount, reason: decline.reason, ...(decline.requestId ? { requestId: decline.requestId } : {}),
      });
    }
    for (const entry of state.entries.filter((e) => e.ownerId === customer.id && e.kind === "funding")) {
      items.push({ id: entry.id, kind: "added", at: entry.createdAt, item: entry.reference, amount: entry.amount, ...(entry.txHash ? { txHash: entry.txHash, explorerUrl: tx(entry.txHash) } : {}) });
    }
    return items.sort((a, b) => b.at.localeCompare(a.at));
  }

  // ---------- spending shared with a person ----------

  private sharedMandate(actor: Actor, id: string): MandateRecord {
    const customer = this.customer(actor);
    const mandate = this.core.read().mandates.find((m) => m.id === id && this.kind(m) === "person" && m.recipient === customer.email);
    requireThat(mandate, 404, "Nothing is shared with you under that name");
    return mandate;
  }

  async sharedOffers(actor: Actor, id: string, query?: string): Promise<Offer[]> {
    this.sharedMandate(actor, id);
    return this.offers(query);
  }

  /** A signed-in person buys from spending shared with them. Their rule on the owner's account decides. */
  async sharedPay(actor: Actor, id: string, body: Record<string, unknown>): Promise<PurchaseOutcome> {
    const mandate = this.sharedMandate(actor, id);
    const offer = await this.offer(body.offerId);
    const commandId = `${actor.id}:shared-pay:${text(body.requestId, "Request ID", 128)}`;
    return this.chain.command(commandId, { id, offer: offer.id }, () => this.buyAs(mandate, offer, `Bought by ${this.customer(actor).name}`));
  }

  // ---------- assistants ----------

  /** An assistant proves it holds `publicKey` and connects with the owner's one-time code. */
  async connect(body: Record<string, unknown>, verified: { key: string }): Promise<AgentConnection> {
    const code = normalizeCode(text(body.code, "Pairing code", 32));
    const state = this.core.read();
    const mandate = state.mandates.find((m) => m.pairingHash === digest(code));
    requireThat(mandate && mandate.status === "waiting" && (mandate.pairingExpiresAt ?? "") > now(), 401, "That code is wrong or has expired. Ask for a new one in Mandate.");
    requireThat(!state.mandates.some((m) => m.agentKey === verified.key), 409, "This key is already connected to a shopper");
    const account = state.accounts.find((a) => a.id === mandate.accountId)!;
    await this.chain.command(`connect:${mandate.id}`, { key: verified.key }, async () => {
      const { ruleId } = await this.chain.addMandate(mandate.id, this.treasury(account), this.chain.wallet(account.id), {
        name: mandate.name, limit: units(mandate.limit), period: mandate.period, expiresAt: mandate.expiresAt, currency: "USD", signer: verified.key,
      });
      this.core.update((s) => {
        const found = s.mandates.find((m) => m.id === mandate.id)!;
        Object.assign(found, { ruleId, agentKey: verified.key, status: "active" });
        delete found.pairingHash;
        delete found.pairingExpiresAt;
      });
      return { ruleId };
    });
    return this.connection(this.core.read().mandates.find((m) => m.id === mandate.id)!);
  }

  private async connection(mandate: MandateRecord): Promise<AgentConnection> {
    const state = this.core.read();
    const account = state.accounts.find((a) => a.id === mandate.accountId)!;
    const owner = state.customers.find((c) => c.id === account.ownerId)!;
    return {
      shopperId: mandate.id, name: mandate.name, ownerName: owner.name, smartAccount: account.address!, ruleId: mandate.ruleId!,
      verifier: this.options.verifier, asset: await this.token(), network: "stellar:testnet", rpcUrl: this.options.rpcUrl,
    };
  }

  /** Checks an agent's signed request and returns its shopper. */
  agent(headers: { key?: string; time?: string; signature?: string }, method: string, path: string, body: string): MandateRecord {
    const { key, time, signature } = headers;
    requireThat(key && StrKey.isValidEd25519PublicKey(key) && time && signature, 401, "Sign this request with the shopper's key");
    requireThat(Math.abs(Date.now() - Number(time)) < 5 * 60_000, 401, "The request signature is too old. Check the clock.");
    const payload = agentSigningPayload(method, path, time, digest(body));
    let valid = false;
    try { valid = Keypair.fromPublicKey(key).verify(Buffer.from(payload), Buffer.from(signature, "base64")); } catch { valid = false; }
    requireThat(valid, 401, "The request signature does not match the shopper's key");
    const mandate = this.core.read().mandates.find((m) => m.agentKey === key);
    requireThat(mandate, 401, "This key is not connected to a shopper. Connect it with a code from Mandate.");
    return mandate;
  }

  /** Lets a connected key prove itself when connecting (no shopper yet). */
  verifyKey(headers: { key?: string; time?: string; signature?: string }, method: string, path: string, body: string): { key: string } {
    const { key, time, signature } = headers;
    requireThat(key && StrKey.isValidEd25519PublicKey(key) && time && signature, 401, "Sign this request with the shopper's key");
    requireThat(Math.abs(Date.now() - Number(time)) < 5 * 60_000, 401, "The request signature is too old. Check the clock.");
    const valid = (() => { try { return Keypair.fromPublicKey(key).verify(Buffer.from(agentSigningPayload(method, path, time, digest(body))), Buffer.from(signature, "base64")); } catch { return false; } })();
    requireThat(valid, 401, "The request signature does not match the key");
    return { key };
  }

  async agentConnection(mandate: MandateRecord): Promise<AgentConnection> { return this.connection(mandate); }

  async budget(mandate: MandateRecord): Promise<AgentBudget> {
    const state = this.core.read();
    const owner = state.customers.find((c) => c.id === state.accounts.find((a) => a.id === mandate.accountId)?.ownerId);
    const spent = await this.spent(mandate);
    const limit = units(mandate.limit);
    return {
      name: mandate.name, ownerName: owner?.name ?? "", status: this.status(mandate),
      limit: mandate.limit, spent: dollars(spent), remaining: dollars(this.status(mandate) === "active" && limit > spent ? limit - spent : 0n),
      period: mandate.period, expiresAt: mandate.expiresAt, currency: "USD",
      trustedStores: (await this.stores()).filter((store) => store.trusted),
    };
  }

  /** The assistant tells us what it bought, or that the account blocked it. */
  async report(mandate: MandateRecord, body: Record<string, unknown>): Promise<{ reason?: string; requestId?: string }> {
    const report = body as unknown as AgentReport;
    const offer = await this.offer(report.offerId);
    const ownerId = this.core.read().accounts.find((a) => a.id === mandate.accountId)!.ownerId;
    if (report.outcome === "paid") {
      requireThat(typeof report.txHash === "string" && /^[0-9a-f]{64}$/.test(report.txHash), 400, "Include the payment's transaction hash");
      this.recordPaid(mandate, ownerId, offer, report.txHash, "mandate", typeof report.note === "string" ? report.note.slice(0, 200) : undefined);
      return {};
    }
    requireThat(report.outcome === "blocked", 400, "Report paid or blocked");
    return this.recordBlocked(mandate, offer);
  }

  async agentRequest(mandate: MandateRecord, id: string): Promise<ApprovalRequest> {
    const state = this.core.read();
    const record = state.requests.find((r) => r.id === id && r.mandateId === mandate.id);
    requireThat(record, 404, "Request not found");
    return this.requestView(record, state);
  }
}

/** "K7Q4-92XD": eight characters, no lookalikes (0/O, 1/I). */
function pairingCode(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const pick = () => alphabet[randomInt(alphabet.length)];
  const part = () => Array.from({ length: 4 }, pick).join("");
  return `${part()}-${part()}`;
}
function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}
