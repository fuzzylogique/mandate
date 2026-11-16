/** Login identities own financial accounts; they never hold funds themselves. */
export type PaymentRail = "traditional" | "blockchain";
export type AccountType = "traditional" | "stellar";
export type FundingMethod = "fiat" | "testnet";
export type PaymentCurrency = string;
export type SpendingPeriod = "day" | "week" | "month";

export interface Customer {
  id: string;
  name: string;
  email: string;
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
  reference: string;
  createdAt: string;
  settlement: "traditional-demo" | "stellar-testnet";
  txHash?: string;
  explorerUrl?: string;
}

export interface PaymentWorkspace {
  mode: "stellar-testnet";
  network?: PaymentNetwork;
  customer: Customer;
  accounts: SpendingAccount[];
  mandates: AccountMandate[];
  shared: { account: SpendingAccount; mandate: AccountMandate; ownerName: string }[];
  activity: PaymentEntry[];
}

export interface OpenAccountInput {
  name: string;
  /** Optional legacy account classification. New accounts need only a name. */
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
  /** The secret ID is the only third-party payment authorization. */
  mandateId: string;
  sellerAddress: string;
  sellerName: string;
  amount: string;
  reference: string;
  requestId: string;
}

export interface MandatePaymentPreview {
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
  accountId: string;
  name: string;
  recipientType: "person" | "agent";
  recipient: string;
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
  faucet: boolean;
  assets?: { currency: string; tokenContract: string; code?: string; issuer?: string }[];
}
