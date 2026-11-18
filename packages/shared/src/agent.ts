// The agent API: what a connected agent (over MCP, LangChain or the CLI) sees
// and sends. Every request after connecting is signed with the agent's own key.
import type { PaymentEntry, SpendingPeriod } from "./payments.ts";

export const NETWORK = "stellar:testnet" as const;

/** Returned when an agent connects with its one-time code. */
export interface AgentConnection {
  agentId: string;
  name: string;
  ownerName: string;
  /** The owner's company, if they set one. */
  company?: string;
  /** The owner's smart account (C-address) the agent spends from. */
  smartAccount: string;
  /** Contract that checks the agent's signature and its registration. */
  agentVerifier: string;
  /** Token contract for USD. */
  asset: string;
  network: typeof NETWORK;
  rpcUrl: string;
  /** Demo stores that sell over x402, if configured. */
  storesUrl?: string;
}

/** A mandate granted to the agent, as the agent sees it. */
export interface AgentMandate {
  reference: string;
  name: string;
  ruleId: number;
  limit: string;
  spent: string;
  remaining: string;
  period: SpendingPeriod;
  expiresAt: string;
  status: "active" | "expired" | "revoked";
  /** Empty or absent: any verified seller. */
  sellerIds?: number[];
}

export interface AgentSellerCheck {
  address: string;
  verified: boolean;
  sellerId?: number;
  name?: string;
}

export interface AgentPaymentInput {
  mandate: string;
  seller: string;
  amount: string;
  reference: string;
  requestId: string;
}

/** The transfer the agent is asked to sign. Mandate submits it and pays the fee. */
export interface PreparedAgentPayment {
  paymentId: string;
  /** Unsigned authorization entry (base64 XDR) for the owner's smart account. */
  authEntry: string;
  expirationLedger: number;
  ruleId: number;
  smartAccount: string;
  agentVerifier: string;
  networkPassphrase: string;
  /** What the agent is approving, for it to check before signing. */
  summary: { seller: string; amount: string; currency: "USD"; reference: string };
}

/** Recording an x402 purchase the agent paid for itself. */
export interface AgentX402Report {
  mandate: string;
  txHash: string;
  url: string;
  reference: string;
}

/** Reporting an x402 purchase the account refused, so the owner sees the attempt. */
export interface AgentDeclineReport {
  mandate: string;
  seller: string;
  amount: string;
  reference: string;
  url?: string;
}

export type AgentPaymentOutcome = { status: "paid"; payment: PaymentEntry }
  | { status: "declined"; reason: string };

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
