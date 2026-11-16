// How money, time and rules are worded for the account owner. Amounts arrive
// as decimal dollar strings ("2.4").
import type { Period, Shopper } from "@mandate/shared/api";

/** "$482" + ".60", so big figures can set the cents smaller. */
export function moneyParts(value: string): { lead: string; tail: string } {
  const [whole = "0", fraction = ""] = Number(value || 0).toFixed(2).split(".");
  return { lead: `$${Number(whole).toLocaleString("en-US")}`, tail: `.${fraction}` };
}

export function money(value: string): string {
  const { lead, tail } = moneyParts(value);
  return lead + tail;
}

/** Like `money`, but drops ".00" so round limits read as "$50". */
export function roundMoney(value: string): string {
  const { lead, tail } = moneyParts(value);
  return tail === ".00" ? lead : lead + tail;
}

const PERIOD_WORDS: Record<Period, { a: string; current: string; every: string; ly: string }> = {
  day: { a: "a day", current: "today", every: "every day", ly: "daily" },
  week: { a: "a week", current: "this week", every: "every week", ly: "weekly" },
  month: { a: "a month", current: "this month", every: "every month", ly: "monthly" },
};

export const periodWords = (period: Period) => PERIOD_WORDS[period];

/** "Up to $50 a week, at trusted stores only" */
export function ruleSummary(shopper: Shopper): string {
  if (shopper.status === "stopped") return "Stopped";
  return `Up to ${roundMoney(shopper.limit)} ${periodWords(shopper.period).a}, at trusted stores only`;
}

export function leftAmount(shopper: Shopper): string {
  const left = Number(shopper.limit) - Number(shopper.spent);
  return String(left > 0 ? left : 0);
}

/** Share of the limit still unspent, 0 to 1. */
export function leftShare(shopper: Shopper): number {
  const limit = Number(shopper.limit);
  if (!limit) return 0;
  return Math.max(0, Math.min(1, Number(leftAmount(shopper)) / limit));
}

export function when(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

/** "in 3 days", "in 5 hours", "now" */
export function fromNow(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 60_000) return "now";
  const hours = ms / 3_600_000;
  if (hours < 1) return `in ${Math.round(ms / 60_000)} min`;
  if (hours < 36) return `in ${Math.round(hours)} hours`;
  return `in ${Math.round(hours / 24)} days`;
}

/** "Saturday, November 14 at 2:14 pm" */
export function fullDate(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
  return `${day} at ${time}`;
}

export const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** "GABC…WXYZ" */
export const short = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;

export const newRequestId = () => crypto.randomUUID();
