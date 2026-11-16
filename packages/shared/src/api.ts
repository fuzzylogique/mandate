// The Mandate API, shared by the service, the web app, the agent kit and (by
// hand, in Swift) the iPhone app. Amounts are decimal strings in dollars,
// e.g. "2.4". Everything is demo USD on Stellar testnet.

export type Period = "day" | "week" | "month";

export interface Customer {
  id: string;
  name: string;
  email: string;
}

/** The customer's one account: a smart account that holds their money. */
export interface Account {
  status: "none" | "ready";
  /** Smart account (C-address). */
  address?: string;
  balance: string;
  currency: "USD";
  explorerUrl?: string;
}

/** A place a shopper can buy from. Trust comes from the on-chain seller registry. */
export interface Store {
  /** Payment address (G-address). */
  address: string;
  name: string;
  domain: string;
  trusted: boolean;
  /** For an untrusted store that imitates a trusted one: the store it looks like. */
  looksLike?: string;
}

/** One thing a store sells. Paid for over x402 at `url`. */
export interface Offer {
  /** "<store slug>/<item id>", unique across stores. */
  id: string;
  title: string;
  price: string;
  store: Store;
  url: string;
}

/**
 * Who does the shopping:
 * - hosted: Mandate runs it on a schedule, with a key Mandate keeps.
 * - assistant: an AI assistant you already use (Claude, ChatGPT…), holding its own key.
 * - person: someone you share spending with; they sign in to pay.
 */
export type ShopperKind = "hosted" | "assistant" | "person";

/** A standing job for a hosted shopper: keep something stocked. */
export interface ShopperJob {
  /** What to buy, matched against store listings, e.g. "herbs". */
  item: string;
  every: Period;
  nextRunAt: string;
  lastRunAt?: string;
  /** What happened last time, in words. */
  lastResult?: string;
}

export interface Shopper {
  id: string;
  name: string;
  kind: ShopperKind;
  /** waiting: an assistant that has not connected yet. */
  status: "active" | "waiting" | "stopped" | "expired";
  limit: string;
  spent: string;
  period: Period;
  expiresAt: string;
  createdAt: string;
  job?: ShopperJob;
  /** Person shoppers: who it is shared with. */
  holder?: string;
  /** Assistant shoppers while waiting: the one-time code to connect with. */
  pairing?: { code: string; expiresAt: string };
  /** Proof: the rule on the account and the key that may sign under it. */
  ruleId?: number;
  agentKey?: string;
  stopPending?: boolean;
}

export type RequestStatus = "pending" | "allowed" | "raised" | "declined" | "failed";

/** A blocked purchase waiting for the owner. */
export interface ApprovalRequest {
  id: string;
  shopper: { id: string; name: string };
  offer: Offer;
  /** Why it was blocked, in words. */
  reason: string;
  /** over-limit can be allowed once or fixed by raising the limit. */
  kind: "over-limit" | "untrusted-store" | "stopped" | "no-money";
  /** For over-limit: the smallest limit that lets this purchase through. */
  suggestedLimit?: string;
  status: RequestStatus;
  createdAt: string;
  resolvedAt?: string;
  txHash?: string;
  /** If something went wrong while acting on the decision. */
  error?: string;
}

export type ApprovalDecision = "allow-once" | "raise-limit" | "decline";

/** One line of activity. */
export interface Activity {
  id: string;
  kind: "paid" | "blocked" | "added";
  at: string;
  shopper?: { id: string; name: string; kind: ShopperKind };
  store?: Store;
  item: string;
  amount: string;
  /** Why the shopper chose this, e.g. "Cheapest of 2 trusted stores". */
  note?: string;
  /** Blocked only. */
  reason?: string;
  requestId?: string;
  /** "mandate": the shopper paid under its rules. "you": you approved it yourself. */
  paidBy?: "mandate" | "you";
  txHash?: string;
  explorerUrl?: string;
  /** For the receipt's proof section. */
  proof?: { smartAccount: string; ruleId?: number; agentKey?: string; checks: string[] };
}

/** Spending someone else shared with you. */
export interface SharedSpending {
  id: string;
  name: string;
  ownerName: string;
  limit: string;
  spent: string;
  period: Period;
  expiresAt: string;
  status: Shopper["status"];
}

export interface Overview {
  customer: Customer;
  account: Account;
  shoppers: Shopper[];
  stores: Store[];
  requests: ApprovalRequest[];
  shared: SharedSpending[];
  network: { name: string; explorerUrl: string };
}

export interface NewShopperInput {
  name: string;
  kind: ShopperKind;
  limit: string;
  period: Period;
  /** ISO date; defaults to 90 days from now. */
  expiresAt?: string;
  /** Hosted only. */
  job?: { item: string; every: Period; startNow?: boolean };
  /** Person only: their email. */
  holder?: string;
  requestId: string;
}

/** Signed-in person paying from shared spending. */
export interface SharedPaymentInput {
  offerId: string;
  requestId: string;
}

export type PurchaseOutcome =
  | { status: "paid"; txHash: string; explorerUrl: string; offer: Offer; note?: string }
  | { status: "blocked"; reason: string; requestId?: string; offer: Offer }
  | { status: "nothing"; reason: string };

// ---------- Agent API (signed with the agent's own key) ----------

/** Returned to an assistant when it connects with a pairing code. */
export interface AgentConnection {
  shopperId: string;
  name: string;
  ownerName: string;
  smartAccount: string;
  ruleId: number;
  verifier: string;
  /** Token contract the shopper pays in. */
  asset: string;
  network: "stellar:testnet";
  rpcUrl: string;
}

export interface AgentBudget {
  name: string;
  ownerName: string;
  status: Shopper["status"];
  limit: string;
  spent: string;
  remaining: string;
  period: Period;
  expiresAt: string;
  currency: "USD";
  trustedStores: Store[];
}

/** What the assistant reports after paying or being blocked. */
export interface AgentReport {
  offerId: string;
  outcome: "paid" | "blocked";
  txHash?: string;
  /** Why it chose this offer, in a sentence. */
  note?: string;
  error?: string;
}

/** Headers an agent signs each request with. */
export const AGENT_HEADERS = {
  key: "x-mandate-agent",
  time: "x-mandate-time",
  signature: "x-mandate-signature",
} as const;

/** The bytes an agent signs: method, path, time and a hash of the body. */
export function agentSigningPayload(method: string, path: string, time: string, bodySha256Hex: string): string {
  return `mandate-agent-v1\n${method.toUpperCase()}\n${path}\n${time}\n${bodySha256Hex}`;
}
