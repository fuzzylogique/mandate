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
}

export interface AccountAgent {
  /** Public identification value. Registration is verified on chain. */
  id: string;
  accountId: string;
  name: string;
  createdAt: string;
  verified: boolean;
  verificationTxHash: string;
  explorerUrl?: string;
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
  requestId?: string;
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
  faucet: boolean;
  assets?: { currency: string; tokenContract: string; code?: string; issuer?: string }[];
}
