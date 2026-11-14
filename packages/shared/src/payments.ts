/** Login identities own financial accounts; they never hold funds themselves. */
export type PaymentRail = "traditional" | "blockchain";
export type AccountType = "traditional" | "stellar";
export type PaymentCurrency = string;
export type SpendingPeriod = "day" | "week" | "month";

export interface Customer {
  id: string;
  name: string;
  email: string;
}

export interface SpendingAccount {
  id: string;
  ownerId: string;
  name: string;
  rail: PaymentRail;
  type: AccountType;
  verified?: boolean;
  verificationTxHash?: string;
  bankDetails?: { bankName: string; accountNumber: string };
  verificationSource?: "demo" | "on-chain";
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
  id: string;
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
  enforcement?: "service" | "on-chain";
  chainRevocationPending?: boolean;
  verifiedRecipientsOnly?: boolean;
  rail?: "traditional" | "blockchain";
}

export interface PaymentEntry {
  id: string;
  accountId: string | null;
  source: string;
  destination: string;
  kind: "funding" | "payment";
  amount: string;
  currency: PaymentCurrency;
  mandateId: string | null;
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
  type: "traditional" | "stellar";
  requestId: string;

}

export interface AccountOpening {
  account: SpendingAccount;
}

export interface MandatePaymentInput {
  mandateId: string;
  sellerAddress: string;
  sellerName: string;
  amount: string;
  reference: string;
  requestId: string;
  rail?: "traditional" | "blockchain";
}

export interface MandatePaymentPreview {
  rail?: "traditional" | "blockchain";
  mandate: { id: string; name: string; address: string; limit: string; spent: string; expiresAt: string };
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
  requestId?: string;
  rail?: "traditional" | "blockchain";
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
}
