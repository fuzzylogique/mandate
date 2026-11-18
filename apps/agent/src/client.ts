// An agent that runs outside Mandate: an AI assistant, a script, a bot.
//
// It keeps its own key in a local file and never shares it. Mandate only learns
// the public half, which the agent registry binds to this agent's id, and which
// is the only signer on every mandate the owner grants it. So Mandate itself
// cannot spend as this agent, and the owner's account checks every payment on
// Stellar: the spending limit, that the seller is verified, and (if the owner
// chose sellers) that it is one of them.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Address, Keypair, scValToNative, xdr } from "@stellar/stellar-sdk";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import {
  AGENT_HEADERS,
  agentSigningPayload,
  formatAmount,
  toBaseUnits,
  type AgentConnection,
  type AgentMandate,
  type AgentPaymentOutcome,
  type AgentSellerCheck,
  type PaymentDecline,
  type PaymentEntry,
  type PreparedAgentPayment,
} from "@mandate/shared";
import { authEntryAddress, signSmartAccountAuthEntry } from "@mandate/shared/smart-account";
import { createPayingFetch, settlementTxHash } from "./purchase.ts";

interface KeyFile {
  secret: string;
  apiUrl: string;
  connection?: AgentConnection;
}

/** A product a store sells over x402. */
export interface StoreItem {
  id: string;
  title: string;
  price: string;
  url: string;
  store: { slug: string; name: string; domain: string; payTo: string; verified: boolean; sellerId?: number };
}

export type PayResult = { status: "paid"; payment: PaymentEntry } | { status: "declined"; reason: string };

export const defaultKeyFile = () => process.env.MANDATE_AGENT_FILE || join(homedir(), ".mandate", "agent.json");

export class MandateAgent {
  private file: string;
  private data: KeyFile;
  private keypair: Keypair;

  constructor(options: { file?: string; apiUrl?: string } = {}) {
    this.file = options.file ?? defaultKeyFile();
    const apiUrl = options.apiUrl ?? (process.env.MANDATE_API_URL || process.env.PAYMENTS_API_URL || "http://localhost:4022");
    if (existsSync(this.file)) {
      this.data = JSON.parse(readFileSync(this.file, "utf8")) as KeyFile;
      if (options.apiUrl) this.data.apiUrl = options.apiUrl;
    } else {
      this.data = { secret: Keypair.random().secret(), apiUrl };
      this.save();
    }
    this.keypair = Keypair.fromSecret(this.data.secret);
  }

  get publicKey() { return this.keypair.publicKey(); }
  get connection() { return this.data.connection; }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }

  /** Calls the Mandate API, signing method, path, time and body with this agent's key. */
  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const text = body === undefined ? "" : JSON.stringify(body);
    const time = String(Date.now());
    const payload = agentSigningPayload(method, path, time, createHash("sha256").update(text).digest("hex"));
    const signature = this.keypair.sign(Buffer.from(payload)).toString("base64");
    let response: Response;
    try {
      response = await fetch(`${this.data.apiUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          [AGENT_HEADERS.key]: this.publicKey,
          [AGENT_HEADERS.time]: time,
          [AGENT_HEADERS.signature]: signature,
        },
        redirect: "error",
        ...(body === undefined ? {} : { body: text }),
      });
    } catch {
      throw new Error(`Can't reach Mandate at ${this.data.apiUrl}`);
    }
    const result = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new MandateError(response.status, result.error ?? `Mandate returned ${response.status}`);
    return result;
  }

  /** Connects with the one-time code the owner got when adding this agent. */
  async connect(code: string): Promise<AgentConnection> {
    const connection = await this.call<AgentConnection>("POST", "/api/agent/connect", { code });
    this.data.connection = connection;
    this.save();
    return connection;
  }

  private requireConnection(): AgentConnection {
    if (!this.data.connection) throw new Error("Not connected yet. Ask the account owner for a code and connect with it.");
    return this.data.connection;
  }

  async me(): Promise<AgentConnection> {
    this.requireConnection();
    const connection = await this.call<AgentConnection>("GET", "/api/agent/me");
    this.data.connection = connection;
    this.save();
    return connection;
  }

  mandates() { this.requireConnection(); return this.call<AgentMandate[]>("GET", "/api/agent/mandates"); }

  checkSeller(address: string) {
    this.requireConnection();
    return this.call<AgentSellerCheck>("GET", `/api/agent/sellers/${encodeURIComponent(address)}`);
  }

  /** Picks the mandate to pay from: the one named, or the only active one. */
  async mandate(reference?: string): Promise<AgentMandate> {
    const active = (await this.mandates()).filter((m) => m.status === "active");
    if (reference) {
      const found = active.find((m) => m.reference === reference || m.name.toLowerCase() === reference.toLowerCase());
      if (!found) throw new Error(`No active mandate called ${reference}.`);
      return found;
    }
    if (active.length === 1) return active[0]!;
    throw new Error(active.length ? `Choose a mandate: ${active.map((m) => m.name).join(", ")}` : "The owner has not given this agent a mandate yet.");
  }

  /**
   * Pays a seller directly. Mandate builds the transfer and pays the network fee;
   * this agent checks the transfer is exactly what it asked for, then signs it.
   */
  async pay(input: { mandate?: string; seller: string; amount: string; reference: string; requestId: string }): Promise<PayResult> {
    const connection = this.requireConnection();
    const mandate = await this.mandate(input.mandate);
    let prepared: PreparedAgentPayment;
    try {
      prepared = await this.call<PreparedAgentPayment>("POST", "/api/agent/payments/prepare", {
        mandate: mandate.reference, seller: input.seller, amount: input.amount, reference: input.reference, requestId: input.requestId,
      });
    } catch (error) {
      if (error instanceof MandateError && error.status < 500) return { status: "declined", reason: error.message };
      throw error;
    }
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(prepared.authEntry, "base64");
    checkTransfer(entry, { token: connection.asset, from: connection.smartAccount, to: input.seller, amount: BigInt(toBaseUnits(input.amount)) });
    signSmartAccountAuthEntry(
      entry,
      { smartAccount: connection.smartAccount, verifier: connection.agentVerifier, keypair: this.keypair, agentId: connection.agentId },
      [mandate.ruleId],
      prepared.expirationLedger,
      prepared.networkPassphrase,
    );
    try {
      return await this.call<AgentPaymentOutcome>("POST", "/api/agent/payments/submit", { paymentId: prepared.paymentId, authEntry: entry.toXDR("base64") });
    } catch (error) {
      if (error instanceof MandateError && error.status < 500) return { status: "declined", reason: error.message };
      throw error;
    }
  }

  /** What a store asks for a product: who gets paid and how much, read from its unpaid 402 answer. */
  private async quote(url: string, asset: string): Promise<{ seller: string; amount: string } | undefined> {
    try {
      const response = await fetch(url, { redirect: "error" });
      if (response.status !== 402) return undefined;
      const header = response.headers.get("PAYMENT-REQUIRED");
      const required = header ? decodePaymentRequiredHeader(header) : (await response.json()) as { accepts?: { asset: string; amount: string; payTo: string }[] };
      const offer = required.accepts?.find((entry) => entry.asset === asset) ?? required.accepts?.[0];
      return offer ? { seller: offer.payTo, amount: formatAmount(offer.amount) } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Every product the demo vendors sell, labelled with whether the seller is verified. */
  async products(query = ""): Promise<StoreItem[]> {
    const { storesUrl } = await this.me();
    if (!storesUrl) throw new Error("No x402 stores are configured for this Mandate.");
    const response = await fetch(`${storesUrl}/catalog`, { redirect: "error" });
    if (!response.ok) throw new Error(`The stores answered ${response.status}`);
    const catalog = (await response.json()) as { stores: { slug: string; name: string; domain: string; payTo: string; items: { id: string; title: string; price: string; url: string }[] }[] };
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const items: StoreItem[] = [];
    for (const store of catalog.stores) {
      const check = await this.checkSeller(store.payTo);
      for (const item of store.items) {
        if (words.length && !words.every((word) => `${item.title} ${item.id} ${store.name}`.toLowerCase().includes(word))) continue;
        items.push({ ...item, store: { slug: store.slug, name: store.name, domain: store.domain, payTo: store.payTo, verified: check.verified, ...(check.sellerId === undefined ? {} : { sellerId: check.sellerId }) } });
      }
    }
    return items.sort((a, b) => Number(a.price) - Number(b.price));
  }

  /**
   * Buys from a store over x402. The payment is signed here with this agent's
   * key and settled by the store's facilitator; the owner's account decides on
   * Stellar whether it is allowed. Then Mandate records it from the chain.
   */
  async buy(url: string, options: { mandate?: string; reference?: string } = {}): Promise<PayResult & { order?: unknown }> {
    const connection = this.requireConnection();
    const mandate = await this.mandate(options.mandate);
    const payingFetch = createPayingFetch({
      payer: { mode: "smart-account", agentSecret: this.data.secret, agentId: connection.agentId, smartAccount: connection.smartAccount, contextRuleId: mandate.ruleId, verifier: connection.agentVerifier },
      extraAsset: connection.asset,
    });
    let response: Response;
    try {
      response = await payingFetch(url);
    } catch (cause) {
      // The account refused to authorize it, or the store could not be reached.
      const reason = cause instanceof Error ? cause.message.split("\n")[0]! : String(cause);
      // Tell the owner what was tried. Mandate works out the reason itself from the seller and amount.
      const quote = await this.quote(url, connection.asset);
      if (quote) {
        try {
          const recorded = await this.call<PaymentDecline>("POST", "/api/agent/declines", { mandate: mandate.reference, seller: quote.seller, amount: quote.amount, reference: options.reference ?? new URL(url).pathname.slice(1), url });
          return { status: "declined", reason: recorded.reason };
        } catch { /* the report is a courtesy: the payment is refused either way */ }
      }
      return { status: "declined", reason };
    }
    const txHash = response.ok ? settlementTxHash(response) : undefined;
    if (!txHash) return { status: "declined", reason: `The store answered ${response.status} and nothing was paid` };
    const order = await response.json().catch(() => undefined);
    const recorded = await this.call<AgentPaymentOutcome>("POST", "/api/agent/x402", { mandate: mandate.reference, txHash, url, reference: options.reference ?? new URL(url).pathname.slice(1) });
    return { ...recorded, order };
  }
}

export class MandateError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Refuses to sign anything but transfer(from, to, amount) on the expected token. */
export function checkTransfer(entry: xdr.SorobanAuthorizationEntry, expected: { token: string; from: string; to: string; amount: bigint }) {
  if (authEntryAddress(entry) !== expected.from) throw new Error("Mandate asked to sign for a different account. Not signing.");
  const invocation = entry.rootInvocation();
  if (invocation.subInvocations().length) throw new Error("The payment includes other calls. Not signing.");
  const fn = invocation.function();
  if (fn.switch().name !== "sorobanAuthorizedFunctionTypeContractFn") throw new Error("Not a token transfer. Not signing.");
  const call = fn.contractFn();
  const [from, to, amount] = call.args();
  const matches = Address.fromScAddress(call.contractAddress()).toString() === expected.token
    && call.functionName().toString() === "transfer" && call.args().length === 3
    && Address.fromScVal(from!).toString() === expected.from
    && Address.fromScVal(to!).toString() === expected.to
    && BigInt(scValToNative(amount!) as bigint) === expected.amount;
  if (!matches) throw new Error("The prepared payment is not the one this agent asked for. Not signing.");
}
