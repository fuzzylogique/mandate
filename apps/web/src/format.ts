// How money, time and limits are worded for the account owner.
import { formatAmount, type Mandate, type MandatePeriod, type TokenInfo } from "@mandate/shared";

/** True when amounts in this token read as plain dollars. */
export const isDollars = (token: TokenInfo) => token.symbol === "USDC";

/**
 * An amount in two parts, so the big figures can set the cents smaller.
 * Dollars: "$482" + ".60". Anything else: "482.6" + " XLM".
 */
export function moneyParts(baseUnits: string, token: TokenInfo): { lead: string; tail: string } {
  const [whole = "0", fraction = ""] = formatAmount(baseUnits).split(".");
  const grouped = Number(whole).toLocaleString("en-US");
  if (isDollars(token)) {
    return { lead: `$${grouped}`, tail: `.${fraction.padEnd(2, "0")}` };
  }
  return { lead: `${grouped}${fraction ? `.${fraction}` : ""}`, tail: ` ${token.symbol}` };
}

/** Dollar-pegged tokens read as dollars; anything else shows its symbol. */
export function money(baseUnits: string, token: TokenInfo): string {
  const { lead, tail } = moneyParts(baseUnits, token);
  return lead + tail;
}

/** Like `money`, but drops ".00" so round limits read as "$50". */
export function roundMoney(baseUnits: string, token: TokenInfo): string {
  const { lead, tail } = moneyParts(baseUnits, token);
  return tail === ".00" ? lead : lead + tail;
}

const PERIOD_WORDS: Record<MandatePeriod, { a: string; current: string }> = {
  day: { a: "a day", current: "today" },
  week: { a: "a week", current: "this week" },
  month: { a: "a month", current: "this month" },
};

export const periodWords = (period: MandatePeriod | null) => PERIOD_WORDS[period ?? "day"];

/** "Up to $50 a week, at trusted stores only" */
export function ruleSummary(shopper: Mandate): string {
  if (shopper.status === "revoked" || shopper.limit === null) return "Stopped";
  return `Up to ${roundMoney(shopper.limit, shopper.token)} ${periodWords(shopper.period).a}, at trusted stores only`;
}

/** What the shopper can still spend in the current period, base units. */
export function leftAmount(shopper: Mandate): string {
  if (!shopper.limit) return "0";
  const left = BigInt(shopper.limit) - BigInt(shopper.spent);
  return (left > 0n ? left : 0n).toString();
}

/** Share of the limit still unspent, 0 to 1. */
export function leftShare(shopper: Mandate): number {
  if (!shopper.limit || shopper.limit === "0") return 0;
  return Math.max(0, Math.min(1, Number(leftAmount(shopper)) / Number(shopper.limit)));
}

export function when(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

/** "Saturday, November 14 at 2:14 pm" */
export function fullDate(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
  return `${day} at ${time}`;
}
