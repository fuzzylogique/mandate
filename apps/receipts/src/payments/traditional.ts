// Deliberately local demo banking. No provider, bank API, or blockchain calls.
import { createHash, randomUUID } from "node:crypto";
import { formatAmount, toBaseUnits } from "@mandate/shared";
import type { PaymentEntry, SpendingAccount } from "@mandate/shared";
import { WorkspaceStore, amount, mandateSpent, requireThat, text, type Actor, type EntryRecord, type State } from "./store.ts";

const decimal = (units: bigint) => formatAmount(units.toString());
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function bankingAmount(value: unknown): bigint {
  const units = amount(value);
  requireThat(typeof value === "string" && /^\d{1,12}(\.\d{1,2})?$/.test(value), 400, "Traditional demo payments use USD with up to two decimal places");
  return units;
}
export class TraditionalBankingDemo {
  private core: WorkspaceStore;
  constructor(core: WorkspaceStore) { this.core = core; }
  private customer(state: State, actor: Actor) {
    const customer = actor.kind === "customer" && state.customers.find(c => c.id === actor.id);
    requireThat(customer, 403, "Sign in to manage banking demo accounts");
    return customer;
  }
  private transaction<T>(actor: Actor, operation: string, requestId: unknown, input: unknown, work: (state: State) => T): T {
    const id = `${actor.id}:banking:${operation}:${text(requestId, "Idempotency key", 128)}`;
    const fingerprint = digest(JSON.stringify(input));
    return this.core.update(state => {
      const saved = state.demoRequests?.find(r => r.id === id);
      requireThat(!saved || saved.fingerprint === fingerprint, 409, "Idempotency key was used with different payment details");
      if (saved) return saved.result as T;
      const result = work(state);
      (state.demoRequests ??= []).push({ id, fingerprint, result });
      return result;
    });
  }
  private entry(state: State, input: Omit<EntryRecord, "id" | "createdAt" | "settlement">): PaymentEntry {
    const entry: EntryRecord = { ...input, id: `demo_${randomUUID()}`, createdAt: new Date().toISOString(), settlement: "traditional-demo" };
    state.entries.push(entry);
    const { ownerId: _owner, actorId: _actor, requestId: _request, ...view } = entry;
    return view;
  }
  open(actor: Actor, body: Record<string, unknown>): SpendingAccount {
    const name = text(body.name, "Account name");
    return this.transaction(actor, "account", body.requestId, { name }, state => {
      const customer = this.customer(state, actor);
      const identifier = digest(`${actor.id}:${String(body.requestId)}`).slice(0, 20).toUpperCase();
      const account: SpendingAccount = {
        id: `BANK_${identifier}`, ownerId: customer.id, name,
        type: "traditional", rail: "traditional", currency: "USD", balance: "0",
        address: `BANK_DEMO_${identifier}`, bankDetails: { bankName: "Mandate Demo Bank", accountNumber: `DEMO-${identifier}` },
        verified: true, verificationSource: "demo", createdAt: new Date().toISOString(),
      };
      state.accounts.push(account);
      return account;
    });
  }
  fund(actor: Actor, accountId: string, body: Record<string, unknown>): PaymentEntry {
    const units = bankingAmount(body.amount);
    requireThat(units <= 1_000_000n * 10_000_000n, 400, "Maximum demo credit is 1,000,000 USD");
    return this.transaction(actor, "funding", body.requestId, { accountId, amount: decimal(units) }, state => {
      const customer = this.customer(state, actor);
      const account = state.accounts.find(a => a.id === accountId && a.ownerId === customer.id && a.rail === "traditional");
      requireThat(account, 404, "Traditional account not found");
      account.balance = decimal(BigInt(toBaseUnits(account.balance)) + units);
      return this.entry(state, { ownerId: customer.id, actorId: actor.id, accountId: account.id, source: "Demo bank funds", destination: account.address!, kind: "funding", amount: decimal(units), currency: "USD", mandateId: null, reference: "Hardcoded banking demo funds" });
    });
  }
  verifiedRecipient(state: State, identifier: string): SpendingAccount | undefined {
    return state.accounts.find(a => a.rail === "traditional" && a.verified && (a.id === identifier || a.address === identifier || a.bankDetails?.accountNumber === identifier));
  }
  pay(actor: Actor, body: Record<string, unknown>): PaymentEntry {
    const units = bankingAmount(body.amount);
    const destination = text(body.destination, "Verified traditional account reference", 128);
    const reference = text(body.reference, "Payment reference", 200);
    return this.transaction(actor, "payment", body.requestId, { accountId: body.accountId, mandateId: body.mandateId ?? null, destination, amount: decimal(units), reference }, state => {
      const account = state.accounts.find(a => a.id === body.accountId && a.rail === "traditional");
      requireThat(account, 404, "Traditional account not found");
      let mandateId: string | null = null;
      if (actor.kind === "agent" || account.ownerId !== actor.id || body.mandateId) {
        const id = actor.kind === "agent" ? actor.mandateId : body.mandateId;
        const mandate = state.mandates.find(m => m.id === id && m.accountId === account.id);
        const customer = actor.kind === "customer" ? state.customers.find(c => c.id === actor.id) : undefined;
        requireThat(mandate && (actor.kind === "agent" || account.ownerId === actor.id || (mandate.recipientType === "person" && mandate.recipient === customer?.email)), 403, "You do not have a mandate for this account");
        requireThat(mandate.status === "active" && mandate.expiresAt > new Date().toISOString(), 403, "This mandate has expired or been revoked");
        requireThat(mandate.verifiedRecipientsOnly, 403, "A verified-recipient payment mandate is required");
        requireThat(mandateSpent(state, mandate) + units <= BigInt(toBaseUnits(mandate.limit)), 403, "Payment exceeds the mandate's spending limit");
        mandateId = mandate.id;
      }
      requireThat(account.verified, 403, "The sending traditional account is not verified");
      const seller = this.verifiedRecipient(state, destination);
      requireThat(seller, 403, "Seller is not a verified traditional demo account");
      const balance = BigInt(toBaseUnits(account.balance));
      requireThat(balance >= units, 409, "Insufficient traditional demo account balance");
      account.balance = decimal(balance - units);
      seller.balance = decimal(BigInt(toBaseUnits(seller.balance)) + units);
      return this.entry(state, { ownerId: account.ownerId, actorId: actor.id, accountId: account.id, source: account.address!, destination: seller.address!, kind: "payment", amount: decimal(units), currency: "USD", mandateId, reference });
    });
  }
}
