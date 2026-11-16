import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { formatAmount, toBaseUnits } from "@mandate/shared";
import type { AccountMandate, Customer, PaymentEntry, PaymentWorkspace, SpendingAccount, SpendingPeriod } from "@mandate/shared";

const deriveKey = promisify(scrypt);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const decimal = (value: bigint) => formatAmount(value.toString());

export class ServiceError extends Error {
  status: number;
  txHash?: string;
  constructor(status: number, message: string, txHash?: string) { super(message); this.status = status; this.txHash = txHash; }
}
export function requireThat(value: unknown, status: number, message: string): asserts value {
  if (!value) throw new ServiceError(status, message);
}
export function text(value: unknown, label: string, max = 120): string {
  requireThat(typeof value === "string" && value.trim().length > 0 && value.trim().length <= max, 400, `${label} is required (maximum ${max} characters)`);
  return value.trim();
}
function email(value: unknown): string {
  const result = text(value, "Email", 254).toLowerCase();
  requireThat(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result), 400, "Enter a valid email address");
  return result;
}
export function amount(value: unknown): bigint {
  requireThat(typeof value === "string" && /^\d{1,12}(\.\d{1,7})?$/.test(value), 400, "Enter a positive amount with up to seven decimal places");
  const units = BigInt(toBaseUnits(value));
  requireThat(units > 0n, 400, "Amount must be greater than zero");
  return units;
}
export interface CustomerRecord extends Customer { password: string }
export interface MandateRecord extends Omit<AccountMandate, "reference" | "enforcement"> {
  id: string; mandateIdHash?: string;
  /** Service mandates are retained only as revoked historical records after upgrade. */
  enforcement?: "service" | "on-chain";
  rail?: "traditional" | "blockchain";
}
export function validateMandateInput(body: Record<string, unknown>): Pick<AccountMandate, "name" | "recipientType" | "recipient" | "limit" | "period" | "expiresAt" | "sellerIds"> {
  requireThat(body.recipientType === "person" || body.recipientType === "agent", 400, "Choose a person or agent");
  requireThat(body.period === "day" || body.period === "week" || body.period === "month", 400, "Choose a spending period");
  const expiry = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : NaN;
  requireThat(Number.isFinite(expiry) && expiry > Date.now(), 400, "Expiry must be in the future");
  const sellerIds = body.sellerIds === undefined ? [] : body.sellerIds;
  requireThat(Array.isArray(sellerIds) && sellerIds.length <= 100 && sellerIds.every(id => Number.isSafeInteger(id) && id > 0), 400, "Seller IDs must be a list of up to 100 positive whole numbers");
  return {
    name: text(body.name, "Mandate name"), recipientType: body.recipientType,
    recipient: body.recipientType === "person" ? email(body.recipient) : text(body.recipient, "Agent identifier"),
    limit: decimal(amount(body.limit)), period: body.period, expiresAt: new Date(expiry).toISOString(),
    ...(sellerIds.length ? { sellerIds: [...new Set<number>(sellerIds)].sort((a, b) => a - b) } : {}),
  };
}
export interface EntryRecord extends Omit<PaymentEntry, "mandateReference"> { mandateId: string | null; ownerId: string; actorId: string; requestId?: string }
/** Private custody records; never included in a workspace or account response. */
export interface StellarAccountPair { accountId: string; classicWalletId: string }
export interface State {
  customers: CustomerRecord[];
  schemaVersion: 1;
  accounts: SpendingAccount[];
  nextSellerId?: number;
  stellarPairs: StellarAccountPair[];
  mandates: MandateRecord[];
  entries: EntryRecord[];
  sessions: { hash: string; customerId: string; expiresAt: string }[];
  traditionalUpgrades?: { accountId: string; balance: string; completed: boolean }[];
  demoRequests?: { id: string; fingerprint: string; result: unknown }[];
}
export function mandateSpent(state: State, mandate: MandateRecord): bigint {
  const durations: Record<SpendingPeriod, number> = { day: 86400_000, week: 7 * 86400_000, month: 30 * 86400_000 };
  const duration = durations[mandate.period];
  const start = Date.parse(mandate.createdAt) + Math.floor((Date.now() - Date.parse(mandate.createdAt)) / duration) * duration;
  return state.entries.filter(e => e.kind === "payment" && e.mandateId === mandate.id && Date.parse(e.createdAt) >= start)
    .reduce((sum, e) => sum + BigInt(toBaseUnits(e.amount)), 0n);
}
export type Actor = { kind: "customer"; id: string } | { kind: "mandate"; id: string; mandateReference: string };
const emptyState = (): State => ({ schemaVersion: 1, customers: [], accounts: [], stellarPairs: [], mandates: [], entries: [], sessions: [] });
const publicCustomer = ({ id, name, email }: CustomerRecord): Customer => ({ id, name, email });
export const publicEntry = ({ ownerId: _owner, actorId: _actor, requestId: _request, mandateId, ...entry }: EntryRecord): PaymentEntry => ({ ...entry, mandateReference: mandateId });

/** Local authentication, workspace ownership and confirmed payment activity. */
export class WorkspaceStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS payment_workspace (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)");
    this.db.prepare("INSERT OR IGNORE INTO payment_workspace VALUES (1, ?)").run(JSON.stringify(emptyState()));
    if (this.read().schemaVersion !== 1) {
      this.db.close();
      throw new ServiceError(503, "This database uses an unsupported workspace layout. Choose a new PAYMENTS_CHAIN_DB.");
    }
    if (this.read().mandates.some(mandate => "tokenHash" in mandate)) this.update(state => {
      for (const mandate of state.mandates) {
        const previous = mandate as MandateRecord & { tokenHash?: string };
        if (previous.tokenHash) mandate.mandateIdHash = previous.tokenHash;
        delete previous.tokenHash;
      }
    });
    // Backfill existing accounts once; IDs persist independently of names or addresses.
    if (this.read().accounts.some(account => account.sellerId === undefined)) this.update(() => {});
  }
  close() { this.db.close(); }
  /** Internal repository access, shared with the chain-backed service. Never exposed over HTTP. */
  read(): State {
    return JSON.parse((this.db.prepare("SELECT body FROM payment_workspace WHERE id=1").get() as { body: string }).body) as State;
  }
  /** Lock before reading so balance checks, debits and journal writes commit together. */
  update<T>(fn: (state: State) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.read();
      const result = fn(state);
      let nextSellerId = state.accounts.reduce((next, account) => Math.max(next, (account.sellerId ?? 0) + 1), state.nextSellerId ?? 1);
      for (const account of state.accounts) {
        if (account.sellerId === undefined) {
          requireThat(Number.isSafeInteger(nextSellerId), 503, "Seller ID capacity reached");
          account.sellerId = nextSellerId++;
        }
      }
      state.nextSellerId = nextSellerId;
      this.db.prepare("UPDATE payment_workspace SET body=? WHERE id=1").run(JSON.stringify(state));
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private customer(state: State, actor: Actor): CustomerRecord {
    const customer = actor.kind === "customer" ? state.customers.find(c => c.id === actor.id) : undefined;
    requireThat(customer, 403, "Sign in to manage your financial accounts");
    return customer;
  }
  private issueSession(state: State, customer: CustomerRecord) {
    const token = randomBytes(32).toString("base64url");
    state.sessions = state.sessions.filter(s => s.expiresAt > now());
    state.sessions.push({ hash: hash(token), customerId: customer.id, expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString() });
    return { token, customer: publicCustomer(customer) };
  }
  async register(body: Record<string, unknown>) {
    const name = text(body.name, "Name");
    const address = email(body.email);
    requireThat(typeof body.password === "string" && body.password.length >= 12 && body.password.length <= 256, 400, "Use a password between 12 and 256 characters");
    const salt = randomBytes(16).toString("hex");
    const key = await deriveKey(body.password, salt, 64) as Buffer;
    return this.update(state => {
      requireThat(!state.customers.some(c => c.email === address), 409, "An account with this email already exists");
      const customer: CustomerRecord = { id: `C_${randomUUID()}`, name, email: address, password: `${salt}:${key.toString("hex")}` };
      state.customers.push(customer);
      return this.issueSession(state, customer);
    });
  }
  async login(body: Record<string, unknown>) {
    const address = email(body.email);
    requireThat(typeof body.password === "string" && body.password.length <= 256, 400, "Password is required");
    const found = this.read().customers.find(c => c.email === address);
    const [salt, expected] = found?.password.split(":") ?? ["unregistered", "00".repeat(64)];
    const actual = await deriveKey(body.password, salt!, 64) as Buffer;
    requireThat(found && timingSafeEqual(actual, Buffer.from(expected!, "hex")), 401, "Email or password is incorrect");
    return this.update(state => this.issueSession(state, state.customers.find(c => c.id === found.id)!));
  }
  authenticateMandate(value: unknown): Actor {
    requireThat(typeof value === "string" && value.trim().length >= 32 && value.trim().length <= 128, 401, "Enter a valid secret mandate ID");
    const mandate = this.read().mandates.find(m => m.mandateIdHash === hash(value.trim()));
    requireThat(mandate && mandate.status === "active" && mandate.expiresAt > now(), 401, "Mandate ID is invalid, expired, or revoked");
    return { kind: "mandate", id: mandate.id, mandateReference: mandate.id };
  }
  authenticate(token: string): Actor {
    const state = this.read();
    const session = state.sessions.find(s => s.hash === hash(token) && s.expiresAt > now());
    requireThat(session, 401, "Please sign in");
    return { kind: "customer", id: session.customerId };
  }
  logout(token: string) { this.update(state => { state.sessions = state.sessions.filter(s => s.hash !== hash(token)); }); }
  mandateView(state: State, mandate: MandateRecord): AccountMandate {
    const { mandateIdHash: _secret, id, rail: _rail, enforcement, ...details } = mandate;
    const view: AccountMandate = { ...details, reference: id, ...(enforcement === "on-chain" ? { enforcement } : {}) };
    view.spent = decimal(mandateSpent(state, mandate));
    view.status = mandate.status === "revoked" ? "revoked" : mandate.expiresAt <= now() ? "expired" : "active";
    return view;
  }
  workspace(actor: Actor): PaymentWorkspace {
    const state = this.read();
    const customer = this.customer(state, actor);
    const accounts = state.accounts.filter(a => a.ownerId === customer.id);
    const owned = new Set(accounts.map(a => a.id));
    const shared = state.mandates.filter(m => m.recipientType === "person" && m.recipient === customer.email && !owned.has(m.accountId)).map(m => ({
      account: state.accounts.find(a => a.id === m.accountId)!,
      mandate: this.mandateView(state, m),
      ownerName: state.customers.find(c => c.id === state.accounts.find(a => a.id === m.accountId)!.ownerId)!.name,
    }));
    const sharedIds = new Set(shared.map(s => s.mandate.reference));
    return {
      mode: "stellar-testnet", customer: publicCustomer(customer), accounts,
      mandates: state.mandates.filter(m => owned.has(m.accountId)).map(m => this.mandateView(state, m)), shared,
      activity: state.entries.filter(e => e.ownerId === customer.id || (e.mandateId && sharedIds.has(e.mandateId))).map(publicEntry).reverse(),
    };
  }
  revoke(actor: Actor, id: string) {
    this.update(state => {
      const mandate = state.mandates.find(m => m.id === id);
      requireThat(mandate, 404, "Mandate not found");
      const customer = this.customer(state, actor);
      requireThat(state.accounts.some(a => a.id === mandate.accountId && a.ownerId === customer.id), 404, "Account not found");
      mandate.status = "revoked";
    });
  }
}
