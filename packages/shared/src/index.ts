// Types and helpers shared by the agent, merchant, receipt service and dashboard.

/** CAIP-2 id of the network everything runs on for the challenge. */
export const NETWORK = "stellar:testnet" as const;

/** Stellar tokens use 7 decimals; USDC amounts on chain are in these units. */
export const TOKEN_DECIMALS = 7;

/** One agent payment, as shown on the dashboard and in the receipt email. */
export interface Receipt {
  /** Stellar RPC event id; unique per payment. */
  id: string;
  txHash: string;
  ledger: number;
  /** ISO timestamp of the ledger close. */
  paidAt: string;
  /** Smart account (C-address) that paid: identifies the owner. */
  smartAccount: string;
  /** Context rule id on that account: identifies the agent's mandate. */
  contextRuleId: number;
  /** Seller's payment account (G-address). */
  seller: string;
  /** Token contract (C-address), USDC for the demo. */
  token: string;
  /** Amount in token base units, as a decimal string. */
  amount: string;
  /** Filled in off-chain; null until the agent or seller annotates. */
  annotation: ReceiptAnnotation | null;
}

/** What was bought. Never stored on chain. */
export interface ReceiptAnnotation {
  txHash: string;
  /** URL the agent paid for. */
  resource: string;
  description?: string;
  agentName?: string;
  sellerDomain?: string;
}

/** "1500000" -> "0.15" */
export function formatAmount(baseUnits: string, decimals = TOKEN_DECIMALS): string {
  const negative = baseUnits.startsWith("-");
  const digits = (negative ? baseUnits.slice(1) : baseUnits).padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** "0.15" -> "1500000" (base units, as a decimal string). */
export function toBaseUnits(amount: string, decimals = TOKEN_DECIMALS): string {
  const [whole = "0", fraction = ""] = amount.trim().split(".");
  const digits = `${whole}${fraction.padEnd(decimals, "0").slice(0, decimals)}`;
  return BigInt(digits || "0").toString();
}

// ---------- Dashboard API (apps/receipts -> apps/web) ----------

export interface TokenInfo {
  /** Token contract (C-address). */
  id: string;
  /** "USDC", "XLM", ... */
  symbol: string;
}

export type MandatePeriod = "day" | "week" | "month";

/** One agent and the rules it spends under. */
export interface Mandate {
  /** Context rule id on the smart account. */
  ruleId: number;
  /** Agent name shown to the owner. */
  name: string;
  status: "active" | "revoked";
  token: TokenInfo;
  /** Limit per period, base units. Null once revoked. */
  limit: string | null;
  /** Spent in the current period, base units. */
  spent: string;
  period: MandatePeriod | null;
  createdAt: string;
}

export interface Seller {
  /** Payment account (G-address). */
  address: string;
  name: string;
  domain: string;
  /** True if the on-chain seller registry lists this account. */
  verified: boolean;
}

/** Something the demo agent can be sent to buy. */
export interface CatalogItem {
  id: string;
  title: string;
  seller: Seller;
  /** Price in whole tokens, e.g. "0.01". */
  price: string;
}

export interface Overview {
  owner: { name: string };
  account: { address: string; token: TokenInfo; balance: string };
  mandates: Mandate[];
  sellers: Seller[];
  catalog: CatalogItem[];
}

/** One line of the activity feed: a payment that went through, or one that was refused. */
export interface Activity {
  id: string;
  kind: "paid" | "declined";
  at: string;
  agent: { ruleId: number; name: string };
  seller: Seller;
  /** What was bought, in words. */
  item: string;
  /** Base units. */
  amount: string;
  token: TokenInfo;
  /** Paid only. */
  txHash?: string;
  /** Declined only: why, in plain words. */
  reason?: string;
}

export interface PurchaseResult {
  status: "paid" | "declined";
  txHash?: string;
  reason?: string;
}
