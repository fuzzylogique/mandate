// A shopper that runs outside Mandate: an AI assistant, a script, a bot.
//
// It keeps its own key in a local file and never shares it. Mandate only ever
// learns the public half, which the owner's account puts on this shopper's rule.
// Every request to Mandate is signed with the key, and every payment is signed
// with it too, so the account itself checks the shopper's limit and stores.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import {
  AGENT_HEADERS,
  agentSigningPayload,
  type AgentBudget,
  type AgentConnection,
  type AgentReport,
  type ApprovalRequest,
  type Offer,
} from "@mandate/shared/api";
import { createPayingFetch, settlementTxHash } from "./purchase.ts";

interface KeyFile {
  secret: string;
  apiUrl: string;
  connection?: AgentConnection;
}

export type BuyResult =
  | { status: "paid"; offer: Offer; txHash: string; explorerUrl: string }
  | { status: "blocked"; offer: Offer; reason: string; requestId?: string };

export const defaultKeyFile = () => process.env.MANDATE_AGENT_FILE ?? join(homedir(), ".mandate", "agent.json");

export class MandateAgent {
  private file: string;
  private data: KeyFile;
  private keypair: Keypair;

  constructor(options: { file?: string; apiUrl?: string } = {}) {
    this.file = options.file ?? defaultKeyFile();
    const apiUrl = options.apiUrl ?? process.env.MANDATE_API_URL ?? "http://localhost:4022";
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

  /** Calls the Mandate API, signing method, path, time and body with this shopper's key. */
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
        ...(body === undefined ? {} : { body: text }),
      });
    } catch {
      throw new Error(`Can't reach Mandate at ${this.data.apiUrl}`);
    }
    const result = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(result.error ?? `Mandate returned ${response.status}`);
    return result;
  }

  /** Connects with the one-time code the owner got when adding this shopper. */
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

  budget() { this.requireConnection(); return this.call<AgentBudget>("GET", "/api/agent/budget"); }

  offers(query?: string) {
    this.requireConnection();
    return this.call<Offer[]>("GET", `/api/agent/offers${query ? `?q=${encodeURIComponent(query)}` : ""}`);
  }

  request(id: string) { return this.call<ApprovalRequest>("GET", `/api/agent/requests/${encodeURIComponent(id)}`); }

  /**
   * Buys an offer. The payment is signed here with this shopper's key and
   * settled through the store's x402 facilitator; the owner's account decides
   * on-chain whether this shopper may make it.
   */
  async buy(offerId: string, note?: string): Promise<BuyResult> {
    const connection = this.requireConnection();
    const offer = (await this.offers()).find((o) => o.id === offerId);
    if (!offer) throw new Error(`No offer with id ${offerId}. Search again for current offers.`);
    const payingFetch = createPayingFetch({
      payer: {
        mode: "smart-account",
        agentSecret: this.data.secret,
        smartAccount: connection.smartAccount,
        contextRuleId: connection.ruleId,
        verifier: connection.verifier,
      },
      extraAsset: connection.asset,
    });
    let txHash: string | undefined;
    let error: string | undefined;
    try {
      const response = await payingFetch(offer.url);
      txHash = response.ok ? settlementTxHash(response) : undefined;
      if (!response.ok) error = `Store answered ${response.status}`;
    } catch (cause) {
      error = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    }
    const report: AgentReport = txHash
      ? { offerId, outcome: "paid", txHash, ...(note ? { note } : {}) }
      : { offerId, outcome: "blocked", ...(error ? { error } : {}) };
    const answer = await this.call<{ reason?: string; requestId?: string }>("POST", "/api/agent/reports", report);
    if (txHash) return { status: "paid", offer, txHash, explorerUrl: `https://stellar.expert/explorer/testnet/tx/${txHash}` };
    return { status: "blocked", offer, reason: answer.reason ?? "Blocked by the account's rules", ...(answer.requestId ? { requestId: answer.requestId } : {}) };
  }
}
