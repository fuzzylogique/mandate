/** Each user has one main account backed by a private Classic/Smart wallet pair. */
export type PaymentRail = "traditional" | "blockchain";
export type AccountType = "traditional" | "stellar";
export type FundingMethod = "fiat" | "testnet";
export interface FiatCheckout {
  status: "checkout";
  provider: "stripe";
  mode: "test";
  sessionId: string;
  url: string;
}
export type FiatFundingStatus = { status: "paid"; payment: PaymentEntry }
  | { status: "pending" | "expired" };
export type PaymentCurrency = string;
export type SpendingPeriod = "day" | "week" | "month";

export interface Customer {
  id: string;
  name: string;
  email: string;
  /** The company this workspace buys for, like "Larkfield Logistics". */
  company?: string;
  /** The team inside the company, like "Operations". */
  team?: string;
}

/** What a purchasing workflow buys. Kept with the mandate for spending reports. */
export const WORKFLOW_CATEGORIES = ["Software", "Cloud and APIs", "Office supplies", "Other"] as const;

/** A verified seller that chose to be listed, so teams can pick it by name. */
export interface Vendor {
  sellerId: number;
  name: string;
  category: string;
  /** The vendor's smart account (C-address). Mandates pay this address. */
  address: string;
}

/** A mandate drafted for an agent that has not connected yet. It goes on chain when the agent connects. */
export interface PendingMandate {
  name: string;
  limit: string;
  period: SpendingPeriod;
  expiresAt: string;
  sellerIds?: number[];
  category?: string;
}

/** A payment an agent tried that the account's rules refused. Nothing was paid. */
export interface PaymentDecline {
  id: string;
  accountId: string;
  agentId: string;
  mandateReference: string | null;
  /** Where the agent tried to pay, when known. */
  destination?: string;
  amount?: string;
  currency: PaymentCurrency;
  reason: string;
  reference: string;
  createdAt: string;
}

export interface AccountAgent {
  /** Public identification value. Registration is verified on chain. */
  id: string;
  accountId: string;
  name: string;
  createdAt: string;
  verified: boolean;
  /** Absent while an agent is waiting to connect: it is registered on chain when it does. */
  verificationTxHash?: string;
  explorerUrl?: string;
  /**
   * waiting: added in the dashboard, has not connected with its code yet.
   * connected: holds its own key, registered on chain; only that key can sign as it.
   * revoked: removed from the registry; it can no longer pay.
   * Absent for agents registered by identification only (no key of their own).
   */
  status?: "waiting" | "connected" | "revoked";
  /** The agent's own public key (G-address) once connected. Mandate never holds its secret. */
  publicKey?: string;
  /** While waiting: the one-time code the agent connects with. */
  pairing?: { code: string; expiresAt: string };
  /** Mandates that will be granted as soon as the agent connects. */
  pending?: PendingMandate[];
}

export interface SpendingAccount {
  id: string;
  /** Stable numeric identifier to share for mandate seller restrictions. */
  sellerId?: number;
  ownerId: string;
  name: string;
  rail: PaymentRail;
  type: AccountType;
  verified?: boolean;
  verificationTxHash?: string;
  verificationSource?: "on-chain";
  currency: PaymentCurrency;
  /** Decimal amounts with seven places; never floating point arithmetic. */
  balance: string;
  address?: string;
  explorerUrl?: string;
  creationTxHash?: string;
  network?: string;
  createdAt: string;
}

export interface AccountMandate {
  /** Non-secret reference for owner management and activity; cannot authorize payment. */
  reference: string;
  accountId: string;
  name: string;
  recipientType: "person" | "agent";
  recipient: string;
  limit: string;
  spent: string;
  period: SpendingPeriod;
  expiresAt: string;
  status: "active" | "expired" | "revoked";
  createdAt: string;
  ruleId?: number;
  enforcement?: "on-chain";
  currency?: string;
  chainRevocationPending?: boolean;
  verifiedRecipientsOnly?: boolean;
  /** Empty or absent permits any verified seller. Checked at payment time. */
  sellerIds?: number[];
  /** What this mandate buys, for spending reports. Not on chain. */
  category?: string;
  /**
   * Set when the mandate is granted to a connected agent: the on-chain rule's
   * only signer is that agent's own key, so only it can spend under the mandate.
   * There is no secret mandate ID for these.
   */
  agentId?: string;
}

export interface PaymentEntry {
  id: string;
  accountId: string | null;
  source: string;
  destination: string;
  kind: "funding" | "payment";
  amount: string;
  currency: PaymentCurrency;
  mandateReference: string | null;
  agentId?: string;
  reference: string;
  createdAt: string;
  settlement: "traditional-demo" | "stellar-testnet";
  /** Present when funding was authorized by a Stripe sandbox payment. */
  stripeSessionId?: string;
  txHash?: string;
  explorerUrl?: string;
}

export interface PaymentWorkspace {
  mode: "stellar-testnet";
  network?: PaymentNetwork;
  customer: Customer;
  /** Main account first. Additional records are retained only for legacy workspaces. */
  accounts: SpendingAccount[];
  agents: AccountAgent[];
  mandates: AccountMandate[];
  shared: { account: SpendingAccount; mandate: AccountMandate; ownerName: string }[];
  activity: PaymentEntry[];
  /** Payments the account's rules refused, newest first. */
  declines: PaymentDecline[];
  /** Listed vendors, to choose approved sellers by name. */
  vendors: Vendor[];
}

export interface OpenAccountInput {
  name: string;
  /** Legacy compatibility only. Opening returns the existing main account. */
  type?: "traditional" | "stellar";
  requestId: string;

}

export interface AccountOpening {
  account: SpendingAccount;
}

export interface MandateCreation {
  mandate: AccountMandate;
  /** Secret payment authorization. Never put this value in URLs or receipts. */
  mandateId: string;
}

export interface MandatePaymentInput {
  /** Secret spending authorization, used together with on-chain agent identification. */
  mandateId: string;
  /** Must be registered on chain for the mandate's source account. */
  agentId: string;
  sellerAddress: string;
  sellerName: string;
  amount: string;
  reference: string;
  requestId: string;
}

export interface MandatePaymentPreview {
  agent: { id: string; name: string; verified: boolean };
  mandate: { name: string; address: string; limit: string; spent: string; expiresAt: string };
  seller: { address: string; name: string; verified: boolean };
  currency: string;
  balance: string;
  checks: { label: string; passed: boolean }[];
}

export type MandatePaymentResult = { status: "paid"; payment: PaymentEntry }
  | { status: "declined"; reason: string }
  | { status: "pending"; reason: string; txHash: string };

export interface CreateAccountMandateInput {
  /** Defaults to the authenticated user's main account. */
  accountId?: string;
  name: string;
  recipientType: "person" | "agent";
  /** Optional agent user; person mandates still require the recipient email. */
  recipient?: string;
  limit: string;
  period: SpendingPeriod;
  expiresAt: string;
  sellerIds?: number[];
  /** Grant the mandate to this connected agent; its own key becomes the rule's signer. */
  agentId?: string;
  category?: string;
  requestId?: string;
}

/** A purchasing workflow: a new agent with its own key, plus the mandate it gets when it connects. */
export interface CreateWorkflowInput {
  name: string;
  category: string;
  limit: string;
  period: SpendingPeriod;
  expiresAt: string;
  sellerIds: number[];
  requestId: string;
}

export interface PaymentNetwork {
  id: string;
  name: string;
  rpcUrl: string;
  horizonUrl: string;
  currency: string;
  tokenContract: string;
  explorerUrl: string;
  smartAccounts: boolean;
  verifiedSmartAccounts?: boolean;
  mandates?: boolean;
  agentVerification?: boolean;
  /** Contract that checks agent signatures; agents that hold their own key sign for it. */
  agentVerifier?: string;
  faucet: boolean;
  assets?: { currency: string; tokenContract: string; code?: string; issuer?: string }[];
}
