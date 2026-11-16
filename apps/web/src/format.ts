import { toBaseUnits } from "@mandate/shared";

/** Display precision only; transaction amounts retain all seven Stellar decimals. */
export function formatValue(amount: string, currency?: string): string {
  if (currency !== "XLM") return amount;
  const units = BigInt(toBaseUnits(amount));
  const absolute = units < 0n ? -units : units;
  if (absolute > 0n && absolute < 10_000n) return units < 0n ? ">-0.001" : "<0.001";
  const rounded = (absolute + 5_000n) / 10_000n;
  const whole = (rounded / 1_000n).toLocaleString("en-US");
  const fraction = (rounded % 1_000n).toString().padStart(3, "0");
  return `${units < 0n ? "-" : ""}${whole}.${fraction}`;
}

export function money(amount: string, currency?: string): string {
  return `${formatValue(amount, currency)}${currency ? ` ${currency}` : ""}`;
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "?";
}
