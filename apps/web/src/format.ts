// How money, time and limits are worded for the account owner.
import { formatAmount, type Mandate, type MandatePeriod, type TokenInfo } from "@mandate/shared";

/** Dollar-pegged tokens read as dollars; anything else shows its symbol. */
export function money(baseUnits: string, token: TokenInfo): string {
  const [whole = "0", fraction = ""] = formatAmount(baseUnits).split(".");
  const grouped = Number(whole).toLocaleString("en-US");
  if (token.symbol === "USDC") {
    return `$${grouped}.${fraction.padEnd(2, "0")}`;
  }
  return `${grouped}${fraction ? `.${fraction}` : ""} ${token.symbol}`;
}

const PERIOD_WORDS: Record<MandatePeriod, { per: string; current: string; resets: string }> = {
  day: { per: "per day", current: "today", resets: "Resets daily" },
  week: { per: "per week", current: "this week", resets: "Resets weekly" },
  month: { per: "per month", current: "this month", resets: "Resets monthly" },
};

export const periodWords = (period: MandatePeriod | null) =>
  PERIOD_WORDS[period ?? "day"];

/** "Up to 2 XLM per day, verified sellers only" */
export function ruleSummary(mandate: Mandate): string {
  if (mandate.status === "revoked" || mandate.limit === null) return "Access revoked";
  return `Up to ${money(mandate.limit, mandate.token)} ${periodWords(mandate.period).per}, verified sellers only`;
}

/** Share of the limit used, 0 to 1. */
export function usedShare(mandate: Mandate): number {
  if (!mandate.limit || mandate.limit === "0") return 0;
  return Math.min(1, Number(mandate.spent) / Number(mandate.limit));
}

export function when(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return `Today, ${time}`;
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

export function fullDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "?";
}

/** A stable hue per name, so each agent keeps its own colour. */
export function hueFor(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}
