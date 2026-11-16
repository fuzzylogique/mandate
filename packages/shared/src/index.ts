export type * from "./payments.ts";
export type * from "./chat.ts";

/** Stellar token amounts use seven decimal places. */
export const TOKEN_DECIMALS = 7;

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
