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
